import { Image } from "@/image/image"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { Canary } from "./canary"
import type { Provider } from "@/provider/provider"
import { Snippet } from "./snippet"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import * as Log from "@redcode-ai/core/util/log"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@redcode-ai/core/session-event"
import { ModelV2 } from "@redcode-ai/core/model"
import { ProviderV2 } from "@redcode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Usage, type LLMEvent } from "@redcode-ai/llm"
import { NgramDetector, RECOVERY_PROMPTS } from "./text-loop-detection"
import * as XmlToolCall from "./xml-tool-call"
import * as InstructionEcho from "./instruction-echo"
import * as RepeatToolReminder from "./repeat-tool-reminder"

const DOOM_LOOP_THRESHOLD = 3
// 260818 Red reasoning 流级 stall 兜底：模型卡死在纯思考流里永不 finish
// （step-3.7-flash 实测——正文/工具从未产出，step-finish 永不到达，runLoop 的
// reasoningOnly 提升逻辑走不到，turn 永不结束，后续用户消息全部 QUEUED）。
// 阈值：reasoning 累积 3 万字符仍无任何 text/tool 产出即判定卡死。正常思考
// 极少超过此量（step-3.7-flash 实测约 3.5K 字符），3 万是约 8 倍余量。
const REASONING_STALL_CHARS = 30000
const log = Log.create({ service: "session.processor" })

export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: MessageV2.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  // 260709 Red fix: Snippet.Service 在 construction 时获取（line 107），process 不再泄漏到 R channel
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  // 260728 Red 上一次 process() 从正文/思考链里打捞出的文本态工具调用（见 xml-tool-call.ts）
  readonly salvagedToolCalls: readonly XmlToolCall.ParsedCall[]
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  inputEnded: boolean
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  // 260710 Red n-gram 文本重复检测（单 step 内）
  ngramDetector: NgramDetector
  ngramTripped: boolean
  // 260812 cc DCP reminder 泄露流式拦截：已触发标志（防同一段多次剥离）
  leakTripped: boolean
  // 260818 Red reasoning 流级 stall 检测：本 step 累积的 reasoning 字符数 +
  // 是否已产出过 text/tool（有产出即不算 stall）+ 是否已触发兜底
  reasoningChars: number
  stepProduced: boolean
  reasoningStallTripped: boolean
  // 260728 Red 文本态工具调用打捞：本 step 注册的工具名（防误判）+ 打捞结果
  toolNames: ReadonlySet<string>
  salvaged: XmlToolCall.ParsedCall[]
  // 260811 cc TTFT：首个分片时刻。必须挂在 ctx 上而不是 assistantMessage.time 上——
  // 消息对象在事件之间会被替换成新对象，写在它上面的守卫会失效、导致重复记录（实测同一条
  // 消息打了 4 次、ms 递增，落库的是最后一次，把 TTFT 高估了几秒）。
  firstChunkAt: number | undefined
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    // 260708 Red acquire snippet service at construction so cleanup captures it (keeps Handle.process R = never)
    const snippetService = yield* Snippet.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        firstChunkAt: undefined,
        reasoningMap: {},
        // 260710 Red n-gram 文本重复检测
        ngramDetector: new NgramDetector(),
        ngramTripped: false,
        leakTripped: false,
        // 260818 Red reasoning 流级 stall 检测
        reasoningChars: 0,
        stepProduced: false,
        reasoningStallTripped: false,
        // 260728 Red 文本态工具调用打捞
        toolNames: new Set<string>(),
        salvaged: [],
      }
      let aborted = false
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      // 260728 Red 文本态工具调用打捞：认出 XML、从可见文本里摘掉、记到 ctx 上。
      // 只在 part 收尾时跑一次（不在 delta 上跑）——标签可能跨 delta 边界，半截的认不出来。
      // 返回 true 表示有命中，调用方据此决定是否要改写 part。
      const salvageToolCalls = (part: { text: string }, source: "text" | "reasoning") => {
        const original = part.text
        const result = XmlToolCall.detect(original, ctx.toolNames)
        part.text = result.stripped
        if (result.calls.length === 0) return part.text !== original
        ctx.salvaged.push(...result.calls)
        slog.warn("toolcall.text_form", {
          sessionID: ctx.sessionID,
          source,
          model: ctx.model.id,
          tools: result.calls.map((call) => call.name),
        })
        return true
      }

      // 260729 Red 剥掉被复述出来的注入指令（见 instruction-echo.ts）。
      // 与上面的 XML 打捞同一条缝、同一类病：模型把"给它看的"当成"要输出的"。
      // 但这里不需要打捞什么 —— 复述出来的指令没有任何执行价值，摘掉即可。
      const stripInstructionEcho = (part: { text: string }, source: "text" | "reasoning") => {
        const result = InstructionEcho.detect(part.text)
        if (result.kinds.length === 0) return false
        part.text = result.stripped
        slog.warn("instruction.echo", {
          sessionID: ctx.sessionID,
          source,
          model: ctx.model.id,
          kinds: result.kinds.join(","),
        })
        return true
      }

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // 260728 Red 泄漏落 reasoning 通道的情况占实测 6/14，这里也要摘
        salvageToolCalls(ctx.reasoningMap[reasoningID], "reasoning")
        stripInstructionEcho(ctx.reasoningMap[reasoningID], "reasoning")
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Reasoning.Ended, {
            sessionID: ctx.sessionID,
            reasoningID,
            text: ctx.reasoningMap[reasoningID].text,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Tool.Input.Started, {
            sessionID: ctx.sessionID,
            callID: input.id,
            name: input.name,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies MessageV2.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
          inputEnded: false,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is MessageV2.FilePart => Schema.is(MessageV2.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: MessageV2.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const toolInput = (value: unknown): Record<string, any> => (isRecord(value) ? value : { value })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        // 260811 cc TTFT 埋点：记下第一个流式分片到达的时刻。放在 switch 之前，任何类型的
        // 首个事件都算数（reasoning-start 往往先于 text-start 到达）。只写一次，不被后续分片覆盖；
        // 重试不重置 created，所以重试场景下这里量到的是"用户视角的等待"（含前几次失败的耗时），
        // 这正是要回答"首次交互为什么慢"时该看的口径。
        if (ctx.firstChunkAt === undefined) {
          ctx.firstChunkAt = Date.now()
          slog.info("llm.ttft", { ms: ctx.firstChunkAt - ctx.assistantMessage.time.created })
        }
        // 每次都写回：消息对象可能被换成新的，只写一次会丢；值取自 ctx 所以不会漂移
        ctx.assistantMessage.time.firstChunk = ctx.firstChunkAt
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Reasoning.Started, {
                sessionID: ctx.sessionID,
                reasoningID: value.id,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            // 260818 Red reasoning 流级 stall 兜底：模型卡死在纯思考流里永不产出。
            // step-finish 永不到达时 runLoop 的 reasoningOnly 提升逻辑（prompt.ts）
            // 走不到 —— turn 永不结束，后续用户消息全部 QUEUED，只能手动中断。
            // 这里在流内直接检测：本 step 已累积超过阈值字符的 reasoning 且从未
            // 产出 text/tool，判定为卡死。处理：把思考提升为可见正文（用户至少
            // 看得到东西，而不是对着一片空白等死），置 finish="stop" 正常收尾。
            // why: docs/notes/implemented/bug-fix/2026-08-18-reasoning-stall-safety-net.md
            if (!ctx.reasoningStallTripped && !ctx.stepProduced) {
              ctx.reasoningChars += value.text.length
              if (ctx.reasoningChars >= REASONING_STALL_CHARS) {
                ctx.reasoningStallTripped = true
                slog.warn("reasoning.stall", {
                  sessionID: ctx.sessionID,
                  chars: ctx.reasoningChars,
                  model: ctx.model.id,
                })
                // 先剥离注入指令复述（防 DCP reminder 之类的泄露跟着思考一起进正文），
                // 再拼接提升为可见正文（与 runLoop 的 reasoningOnly.promoted 同款做法）
                for (const p of Object.values(ctx.reasoningMap)) stripInstructionEcho(p, "reasoning")
                const reasoningText = Object.values(ctx.reasoningMap)
                  .map((p) => p.text)
                  .join("\n\n")
                const now = Date.now()
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "text",
                  text: reasoningText,
                  time: { start: now, end: now },
                })
                // 收尾 reasoning part（设 end time、落库），与正常 step-finish 行为一致
                yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
                ctx.assistantMessage.finish = "stop"
                // 260818 Red finish 必须落库：runLoop 下一轮的 break 条件读
                // lastAssistant.finish（prompt.ts），只改内存对象会导致死循环重发
                yield* session.updateMessage(ctx.assistantMessage)
              }
            }
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            // 260818 Red 有工具产出了，reasoning stall 检测解除
            ctx.stepProduced = true
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            // AI SDK emits a final `tool-call` with the parsed `input`; accumulating
            // delta fragments into `state.raw` is redundant work for no current consumer.
            return

          case "tool-input-end": {
            const toolCall = yield* ensureToolCall(value)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Input.Ended, {
                sessionID: ctx.sessionID,
                callID: value.id,
                text: "",
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.toolcalls[value.id] = { ...toolCall.call, inputEnded: true }
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            const toolCall = yield* ensureToolCall(value)
            const input = toolInput(value.input)
            if (!toolCall.call.inputEnded) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Tool.Input.Ended, {
                  sessionID: ctx.sessionID,
                  callID: value.id,
                  text: "",
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Called, {
                sessionID: ctx.sessionID,
                callID: value.id,
                tool: value.name,
                input,
                provider: {
                  executed: toolCall.part.metadata?.providerExecuted === true,
                  ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            // 260629 Red canary leak check in tool-call arguments.
            if (Canary.check(JSON.stringify(input), ctx.sessionID)) {
              slog.error("canary.leak", { sessionID: ctx.sessionID, source: "tool-call", tool: value.name })
              throw new Error("Session terminated: canary token leaked in tool call input")
            }

            // 260806 Red 取样范围从「当前助手消息内部」改为「本会话最近的 tool 分片（跨消息）」。
            // step-3.7-flash 实测会把同一个工具调用逐步重发 3–8 次，每步各是一条独立助手消息、
            // 每条只含一个 tool 分片，旧取样在单条消息内永远凑不满阈值，检测器一次都没触发过。
            const parts = MessageV2.recentToolParts(ctx.sessionID, DOOM_LOOP_THRESHOLD * 2)
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            const outputKey = (part: (typeof recentParts)[number]) =>
              part.type === "tool" && part.state.status === "completed" ? JSON.stringify(part.state.output ?? "") : null

            // Existing: exact same tool × DOOM_LOOP_THRESHOLD consecutive
            const exactLoop =
              recentParts.length === DOOM_LOOP_THRESHOLD &&
              recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              ) &&
              // 260725 至少一次报错 —— 原判据保留
              (recentParts.some((part) => part.type === "tool" && part.state.status === "error") ||
                // 260806 Red 新增：同工具 + 同输入 + **同输出**连续 3 次，即使全部成功也算空转
                // （模型收到结果仍原样重发；实测 grep/read 各重复 4–8 次，输出每次一模一样）。
                // 要求输出也相同，是为了不误伤轮询类调用——那种每次输出都在变。
                (() => {
                  const outs = recentParts.map(outputKey)
                  return outs[0] !== null && outs.every((o) => o === outs[0])
                })())

            // Extended: cycling pattern (A→B→A→B or A→B→C→A→B→C)
            const CYCLE_WINDOW = DOOM_LOOP_THRESHOLD * 2
            const cycleParts = parts.slice(-CYCLE_WINDOW)
            const cycleLoop =
              !exactLoop &&
              cycleParts.length === CYCLE_WINDOW &&
              cycleParts.every((p) => p.type === "tool" && p.state.status !== "pending") &&
              // 260725 Only trigger when at least one tool actually errored
              cycleParts.some((p) => p.type === "tool" && p.state.status === "error") &&
              [2, 3].some((len) => {
                if (CYCLE_WINDOW % len !== 0) return false
                const key = (p: (typeof cycleParts)[number]) =>
                  p.type === "tool" ? `${p.tool}\0${JSON.stringify(p.state.input)}` : ""
                const pattern = cycleParts.slice(0, len).map(key)
                return cycleParts.every((p, i) => key(p) === pattern[i % len])
              })

            if (!exactLoop && !cycleLoop) return

            const cycleTools = cycleLoop
              ? [...new Set(cycleParts.flatMap((p) => (p.type === "tool" ? [p.tool] : [])))]
              : [value.name]

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: cycleTools,
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: cycleTools,
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<MessageV2.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            // 260814 Red 重复调用软层提醒（阈值 3/5/8 递进，纯建议不拦截）：同工具+同参
            // 连续调用即计数，不要求报错/同输出——轮询类只会走到这里，真空转另有上面
            // tool-call case 的 doom_loop 硬层弹窗兜底。贴 output 尾部，不伪装 user 角色。
            // 取舍与口径详见 repeat-tool-reminder.ts。
            if (toolCall && !RepeatToolReminder.EXCLUDED_TOOLS.has(toolCall.part.tool)) {
              const inputJSON = JSON.stringify(toolCall.part.state.input)
              const priorParts = MessageV2.recentToolParts(ctx.sessionID, 24).filter(
                (part) => part.id !== toolCall.part.id,
              )
              const reminder = RepeatToolReminder.reminderFor(
                toolCall.part.tool,
                inputJSON,
                RepeatToolReminder.chainLength(priorParts, toolCall.part.tool, inputJSON) + 1,
              )
              if (reminder) {
                slog.info("repeat.reminder", { sessionID: ctx.sessionID, tool: toolCall.part.tool })
                output.output = `${output.output}\n\n${reminder}`
              }
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Success, {
                sessionID: ctx.sessionID,
                callID: value.id,
                structured: output.metadata,
                content: [
                  {
                    type: "text",
                    text: output.output,
                  },
                  ...(output.attachments?.map((item: MessageV2.FilePart) => ({
                    type: "file" as const,
                    uri: item.url,
                    mime: item.mime,
                    name: item.filename,
                  })) ?? []),
                ],
                provider: {
                  executed: value.providerExecuted === true || toolCall?.part.metadata?.providerExecuted === true,
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            const toolCall = yield* readToolCall(value.id)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Failed, {
                sessionID: ctx.sessionID,
                callID: value.id,
                error: {
                  type: "unknown",
                  message: value.message,
                },
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            // 260818 Red reasoning stall 检测按 step 重置：每个新 step 重新计数
            ctx.reasoningChars = 0
            ctx.stepProduced = false
            ctx.reasoningStallTripped = false
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Step.Started, {
                  sessionID: ctx.sessionID,
                  agent: input.assistantMessage.agent,
                  model: {
                    id: ModelV2.ID.make(ctx.model.id),
                    providerID: ProviderV2.ID.make(ctx.model.providerID),
                    variant: ModelV2.VariantID.make(input.assistantMessage.variant ?? "default"),
                  },
                  snapshot: ctx.snapshot,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
              // 260816 Red: 峰谷定价按 step 完成时刻查价（记账定格，历史费用不随改价跳变）
              time: Date.now(),
            })
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Step.Ended, {
                  sessionID: ctx.sessionID,
                  finish: value.reason,
                  cost: usage.cost,
                  tokens: usage.tokens,
                  snapshot: completedSnapshot,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            // 260706 Red: 消息级 tokens 必须像 cost 一样跨 step 累加——一次 assistant 消息可能含多个
            // agentic step（每次工具调用往返算一个 step），此前直接覆盖导致只保留最后一个 step 的数据，
            // 早期 step 的 tokens/cache 读写数字全部丢失。GUI 上下文面板据此汇总缓存命中率，
            // 会和真实累加的 cost 对不上账（cost 正确但 tokens/缓存命中率被严重低估）。
            const prevTokens = ctx.assistantMessage.tokens
            ctx.assistantMessage.tokens = {
              total: (prevTokens.total ?? 0) + (usage.tokens.total ?? 0),
              input: prevTokens.input + usage.tokens.input,
              output: prevTokens.output + usage.tokens.output,
              reasoning: prevTokens.reasoning + usage.tokens.reasoning,
              cache: {
                read: prevTokens.cache.read + usage.tokens.cache.read,
                write: prevTokens.cache.write + usage.tokens.cache.write,
                miss: (prevTokens.cache.miss ?? 0) + (usage.tokens.cache.miss ?? 0),
              },
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            // 260710 Red 每个新 text part 重置 n-gram 检测器
            ctx.ngramDetector.reset()
            ctx.ngramTripped = false
            ctx.leakTripped = false
            // 260818 Red 有正文产出了，reasoning stall 检测解除
            ctx.stepProduced = true
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Text.Started, {
                  sessionID: ctx.sessionID,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            // 260710 Red n-gram 重复检测：流式 delta 累积，发现重复立即中断
            if (!ctx.ngramTripped && ctx.ngramDetector.feed(value.text)) {
              ctx.ngramTripped = true
              slog.warn("ngram.repeat", { sessionID: ctx.sessionID, textLen: ctx.currentText.text.length })
              yield* bus.publish(Session.Event.LoopDetected, {
                sessionID: ctx.sessionID,
                type: "ngram" as const,
                textLen: ctx.currentText.text.length,
              })
              ctx.currentText.text += "\n\n" + RECOVERY_PROMPTS.stop
              ctx.shouldBreak = true
            }
            // 260812 cc DCP reminder 泄露流式拦截：累积文本出现泄露锚点立即中断+剥离。
            // 泄露是消息尾部的复述循环（GUI 实测无限刷屏），发现即止损——已推送的 delta
            // 无法撤回，但剥离后的文本会落库，且不再继续输出。ngram 拦不住它（复述并非
            // 逐字重复，是同一段语义反复）。
            if (!ctx.leakTripped && InstructionEcho.hasLeakAnchor(ctx.currentText.text)) {
              ctx.leakTripped = true
              slog.warn("leak.dcp-reminder", { sessionID: ctx.sessionID, textLen: ctx.currentText.text.length })
              ctx.currentText.text = InstructionEcho.detect(ctx.currentText.text).stripped
              ctx.shouldBreak = true
            }
            return

          case "text-end":
            if (!ctx.currentText) return
            // 260728 Red 先摘掉文本态工具调用，再交给 plugin / canary / 落库，
            // 三者看到的都应该是干净正文
            salvageToolCalls(ctx.currentText, "text")
            stripInstructionEcho(ctx.currentText, "text")
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Text.Ended, {
                  sessionID: ctx.sessionID,
                  text: ctx.currentText.text,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            // 260629 Red canary leak check: if the model echoed the session marker,
            // it likely revealed the system prompt — terminate immediately.
            if (Canary.check(ctx.currentText.text, ctx.sessionID)) {
              slog.error("canary.leak", { sessionID: ctx.sessionID, source: "text" })
              throw new Error("Session terminated: canary token leaked in assistant output")
            }
            // 260630 Red restore text-part finalize accidentally dropped by canary commit 1220d25af:
            // persist final (plugin-transformed) text + text-end providerMetadata, then reset currentText.
            // Without this, interleaved text→tool→text within one step lost the first part's final text.
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            if (value.routedVia) ctx.assistantMessage.routedVia = value.routedVia
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
        // 260629 Red DO NOT clear canary here — clearing regenerates the token next turn,
        // mutating the system prompt suffix and breaking DeepSeek prefix cache every turn.
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error)) {
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        if (!ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          if (flags.experimentalEventSystem) {
            yield* events.publish(SessionEvent.Step.Failed, {
              sessionID: ctx.sessionID,
              error: {
                type: "unknown",
                message: errorMessage(e),
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
          }
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        // 260728 Red 打捞只认本 step 真实注册的工具名，避免把讨论/日志里出现的
        // <tool_call> 字样当成真调用摘掉
        ctx.toolNames = new Set(Object.keys(streamInput.tools ?? {}))
        ctx.salvaged = []

        // 260625 Red 基线快照：进入本 step 前已存在的 part。重试时据此删掉失败那次新建的所有 part。
        // 一次 process() = 一个 step = 一条流（见 prompt.ts），断流必发生在 step-finish 之前，
        // 故失败那次不会改 message.cost/tokens，无需回滚计费；仅需清掉它落库的 part 与在途追踪。
        const baseline = new Set(MessageV2.parts(ctx.assistantMessage.id).map((p) => p.id))
        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            // 重试前清理上一次失败遗留的 part：从头重跑会重新生成全部内容，
            // 不删旧 part 会造成消息里 text/reasoning/tool/step 重复。首次进入时无新增，自然 no-op。
            for (const part of MessageV2.parts(ctx.assistantMessage.id)) {
              if (baseline.has(part.id)) continue
              yield* session.removePart({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: part.id,
              })
            }
            // 丢弃在途追踪，避免 cleanup 触碰已删除的 part（readToolCall 对已删 part 返回 null 而跳过）。
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            ctx.toolcalls = {}
            // 260728 Red 重试会从头重跑，上一次打捞的结果一并作废
            ctx.salvaged = []
            yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction || ctx.reasoningStallTripped),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                set: (info) => {
                  // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
                  const event = flags.experimentalEventSystem
                    ? events.publish(SessionEvent.Retried, {
                        sessionID: ctx.sessionID,
                        attempt: info.attempt,
                        error: {
                          message: info.message,
                          isRetryable: true,
                        },
                        timestamp: DateTime.makeUnsafe(Date.now()),
                      })
                    : Effect.void
                  return event.pipe(
                    Effect.andThen(
                      status.set(ctx.sessionID, {
                        type: "retry",
                        attempt: info.attempt,
                        message: info.message,
                        action: info.action,
                        next: info.next,
                      }),
                    ),
                  )
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          // 260818 Red reasoning stall 兜底触发：思考已提升为正文、finish 已置 stop，
          // 与正常收尾同路径退出（runLoop 里 finish="stop" 会走正常 break 分支）
          if (ctx.reasoningStallTripped) return "stop"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        get salvagedToolCalls() {
          return ctx.salvaged
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    // 260708 Red wire Snippet.Service required by cleanup's snippet clear
    Layer.provide(Snippet.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
