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
import { Freeform } from "@/tool/freeform"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Usage, type LLMEvent } from "@redcode-ai/llm"
import { NgramDetector, RECOVERY_PROMPTS } from "./text-loop-detection"
import * as XmlToolCall from "./xml-tool-call"
import * as InstructionEcho from "./instruction-echo"
import * as RepeatToolReminder from "./repeat-tool-reminder"
import * as ToolFailureGuard from "./tool-failure-guard"
import * as ConfigToolFailure from "@/config/tool-failure"
import { ConfigReasoningStall } from "@/config/reasoning-stall"

const DOOM_LOOP_THRESHOLD = 3
// 260818 Red reasoning 流级 stall 兜底：模型卡死在纯思考流里永不 finish
// （step-3.7-flash 实测——正文/工具从未产出，step-finish 永不到达，runLoop 的
// reasoningOnly 提升逻辑走不到，turn 永不结束，后续用户消息全部 QUEUED）。
// 261020 Red 判据换代：主判据是「静默时长」（Stream.timeoutOrElse，配置
// experimental.reasoningStall.idleMs）；字符量只作防无限流的高额兜底
// （maxChars）。原先硬编码 30,000 字符会把 max 推理档的正常长思考当卡死掐断——
// 261007–261020 实测 53 次，step-5/glm/deepseek 的正文分片精确停在 30,00x 字符。
// 决策与证据：docs/notes/implemented/bug-fix/2026-08-18-reasoning-stall-safety-net.md
const log = Log.create({ service: "session.processor" })
// 260930 Red 未声明币种却报了的付费模型，每模型只 warn 一次（同进程内）。
const warnedMissingCurrency = new Set<string>()

export type Result = "compact" | "stop" | "continue"

// 261013 Red Diagnostic-only, monotonic timestamps; never part of persisted/model-visible messages.
export interface CompactionTiming {
  firstEventAt?: number
  firstContentAt?: number
  streamCompletedAt?: number
  usageMs: number
  cleanupMs: number
  eventHandlingMs: number
  attempts: number
}

export interface Handle {
  readonly message: MessageV2.Assistant
  readonly compactionTiming?: CompactionTiming
  readonly stoppedByPermission?: boolean
  readonly stoppedByToolFailure?: boolean
  readonly guardToolCall?: (name: string, input: unknown) => Effect.Effect<void>
  readonly updateToolCall: (
    toolCallID: string,
    name: string,
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
  readonly process: (streamInput: LLM.StreamInput, onResponse?: Effect.Effect<void>) => Effect.Effect<Result>
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
  // 261021 Red 该 callID 的 part 已经终结（completed/error）后又被复用（中断后迟到的同一事件）：
  // 后续事件只能读、不能再改状态，否则 part 会被推回 running 且永远等不到新的 result。
  sealed?: boolean
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  toolFailureStopped: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  // 260710 Red n-gram 文本重复检测（单 step 内）
  ngramDetector: NgramDetector
  ngramTripped: boolean
  // 260812 cc DCP reminder 泄露流式拦截：已触发标志（防同一段多次剥离）
  leakTripped: boolean
  // 260903 cc 泄露锚点的增量扫描器（原先每条 delta 扫全文，O(n²)）
  leakScanner: InstructionEcho.LeakAnchorScanner
  // 261014 Red 泄露标记暂扣缓冲：锚点命中后，从锚点起的增量暂扣到这里，等闭合 `]`
  // 出现再放行（undefined = 不在暂扣态）。见 text-delta 分支。
  leakHold: string | undefined
  leakPending: string
  // 260818 Red reasoning 流级 stall 检测：本 step 累积的 reasoning 字符数 +
  // 是否已产出过 text/tool（有产出即不算 stall）+ 是否已触发兜底
  reasoningChars: number
  stepProduced: boolean
  reasoningStallTripped: boolean
  // 260728 Red 文本态工具调用打捞：本 step 注册的工具名（防误判）+ 打捞结果
  toolNames: ReadonlySet<string>
  salvaged: XmlToolCall.ParsedCall[]
  // 261017 Red 本 step 是否已经产生过工具调用。AI SDK 会在 tool-call 事件之前就启动
  // execute（见 updateToolCall 里的注释），所以只要 part 建出来就算"可能已有副作用"。
  // 重试策略据此放弃自动重放，见 SessionRetry.policy 的 toolsStarted。
  toolsStarted: boolean
  // 260811 cc TTFT：首个分片时刻。必须挂在 ctx 上而不是 assistantMessage.time 上——
  // 消息对象在事件之间会被替换成新对象，写在它上面的守卫会失效、导致重复记录（实测同一条
  // 消息打了 4 次、ms 递增，落库的是最后一次，把 TTFT 高估了几秒）。
  firstChunkAt: number | undefined
}

type StreamEvent = LLMEvent

function isModelResponse(value: StreamEvent) {
  switch (value.type) {
    case "text-start":
    case "text-delta":
    case "reasoning-start":
    case "reasoning-delta":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-call":
      return true
    case "step-finish":
    case "finish":
      return (
        value.reason === "stop" ||
        value.reason === "length" ||
        value.reason === "tool-calls" ||
        value.reason === "content-filter"
      )
    default:
      return false
  }
}

export class Service extends Context.Service<Service, Interface>()("@redcode/SessionProcessor") {}

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

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const cfg = yield* config.get()
      const failureLimit = ConfigToolFailure.resolve(cfg.experimental?.repeated_tool_failure_limit)
      // 261020 Red 纯思考兜底阈值：静默时长 + 字符兜底，均由配置拥有方解析（见 config/reasoning-stall.ts）。
      const stall = ConfigReasoningStall.resolve(cfg.experimental?.reasoningStall)
      const compactionTiming: CompactionTiming | undefined = input.assistantMessage.summary
        ? { usageMs: 0, cleanupMs: 0, eventHandlingMs: 0, attempts: 0 }
        : undefined
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        toolFailureStopped: false,
        needsCompaction: false,
        currentText: undefined,
        firstChunkAt: undefined,
        reasoningMap: {},
        // 260710 Red n-gram 文本重复检测
        ngramDetector: new NgramDetector(),
        ngramTripped: false,
        leakTripped: false,
        leakScanner: new InstructionEcho.LeakAnchorScanner(),
        leakHold: undefined,
        leakPending: "",
        // 260818 Red reasoning 流级 stall 检测
        reasoningChars: 0,
        stepProduced: false,
        reasoningStallTripped: false,
        // 260728 Red 文本态工具调用打捞
        toolNames: new Set<string>(),
        salvaged: [],
        toolsStarted: false,
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

      // 261021 Red 内存 miss 后先查库再建 part。中断（abort）时 settleToolCall 删掉了 ctx.toolcalls
      // 条目，迟到的同一 callID 事件会被 updateToolCall / ensureToolCall 当成新调用，在**同一条**
      // assistant 消息里建出第二条 tool part ⇒ 出站 assistant.tool_calls 重复 ⇒ DeepSeek 400
      // "Duplicate value for 'tool_call_id' of … in message[N]"（ses_ffe5ea3f… 实证）。
      // 命中则复用原 part；已终结的标 sealed，后续事件只读不改状态。
      // 决策：docs/notes/implemented/bug-fix/2026-10-21-duplicate-tool-call-id.md
      const adoptPersistedToolCall = Effect.fn("SessionProcessor.adoptPersistedToolCall")(function* (
        toolCallID: string,
      ) {
        const part = MessageV2.findToolPartByCallID(ctx.assistantMessage.id, toolCallID)
        if (!part) return undefined
        ctx.toolcalls[toolCallID] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
          inputEnded: true,
          sealed: part.state.status === "completed" || part.state.status === "error",
        }
        return { call: ctx.toolcalls[toolCallID], part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        name: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        // 260825 cc adopt 的触发条件收窄到"从未注册过"。readToolCall 的 miss 有两个
        // 来源：① ctx.toolcalls 里根本没有这个 callID —— 就是下面注释说的那个竞态；
        // ② 注册过、但 part 在库里查不到或类型不对，此时它会顺手 delete 掉该条目
        //（见 readToolCall）。②（revert / 压缩把 part 移走等）若也去 adopt，等于在
        // **当前** assistantMessage 上复活一个本属于别处的 pending part，属于错挂。
        // 所以先在 readToolCall 之前记下"是否注册过"，只对 ① 兜底，② 保持原来的
        // 静默 no-op。
        const known = toolCallID in ctx.toolcalls
        let match = yield* readToolCall(toolCallID)
        // 260824 Red AI SDK v7 在 fullStream 推出 tool-call 事件之前就启动 execute：
        // TaskTool.execute 的 ctx.metadata 回调先于 ensureToolCall 到达，ctx.toolcalls
        // 未注册、DB 里也没有对应 part（消息尚未落库）→ readToolCall miss，旧代码
        // 静默丢了 metadata，流事件路径补写的 running state 不带 title/metadata。
        // 兜底：按 callID 现场创建 pending tool part（同 ensureToolCall 创建分支），
        // 让 update 把 title/metadata 写进去；随后的 ensureToolCall 走 existing 分支。
        if (!match && !known) match = yield* adoptOrphanToolCall(toolCallID, name)
        if (!match) return undefined
        // 261021 Red 已终结的 part 不接受状态回退：迟到事件重放会把它改回 running，
        // 而对应的 result 早已被消费（completeToolCall 的 running 卫直接丢弃），part 会卡死。
        if (match.call.sealed) return match.part
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const adoptOrphanToolCall = Effect.fn("SessionProcessor.adoptOrphanToolCall")(function* (
        toolCallID: string,
        name: string,
      ) {
        // 261021 Red adopt 也是"新建 part"入口，同样必须先认库里已有的同 callID part，
        // 否则 interrupted 之后迟到的事件会在同一条消息上写第二条（见 adoptPersistedToolCall）。
        const persisted = yield* adoptPersistedToolCall(toolCallID)
        if (persisted) return persisted
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: name,
          callID: toolCallID,
          state: { status: "pending", input: {}, raw: "" },
        } satisfies MessageV2.ToolPart)
        ctx.toolsStarted = true
        ctx.toolcalls[toolCallID] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
          inputEnded: false,
        }
        return { call: ctx.toolcalls[toolCallID], part }
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
        // 261021 Red 核心签名维度：参数无关字段抖动的同错重试不再重开失败预算（防红线绕过），
        // inputSignature 保留用于诊断与 guardToolCall 的执行前精确拦截。
        const inputSignature = ToolFailureGuard.inputSignature(match.part.tool, match.part.state.input)
        const text = errorMessage(error)
        const errorSignature = ToolFailureGuard.signature(text)
        const coreSignature = ToolFailureGuard.coreSignature(match.part.tool, text)
        const blocked = text === ToolFailureGuard.BLOCKED
        const count = blocked ? failureLimit : ToolFailureGuard.count({
          sessionID: ctx.sessionID,
          parentID: ctx.assistantMessage.parentID,
          coreSignature,
        }) + 1
        // 261015 Red 同一并行批可能在错误回传前全已启动，超预算后仍须封死下一次模型请求。
        if (count > failureLimit) ctx.toolFailureStopped = true
        const reminder = !blocked && count === failureLimit ? ToolFailureGuard.reminder(failureLimit) : undefined
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: reminder ? `${text}\n\n${reminder}` : text,
            metadata: {
              failureGuard: { inputSignature, coreSignature, errorSignature, count, blocked },
            },
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      // 261015 Red 失败预算执行闸门：同轮同参同错累计到上限后，原样调用不再执行并结束本轮
      // （不再发下一次模型请求）。决策与实测请求数见
      // docs/notes/implemented/bug-fix/2026-10-15-tool-failure-budget.md
      const guardToolCall = Effect.fn("SessionProcessor.guardToolCall")(function* (name: string, input: unknown) {
        if (ctx.assistantMessage.summary) return
        const count = ToolFailureGuard.count({
          sessionID: ctx.sessionID,
          parentID: ctx.assistantMessage.parentID,
          inputSignature: ToolFailureGuard.inputSignature(name, input),
        })
        if (count < failureLimit) return
        ctx.toolFailureStopped = true
        slog.warn("tool.failure.budget", { tool: name, count, limit: failureLimit })
        return yield* Effect.die(new Error(ToolFailureGuard.BLOCKED))
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
        // 261021 Red 建新 part 之前先认库里已有的同 callID part（见 adoptPersistedToolCall）。
        const persisted = yield* adoptPersistedToolCall(input.id)
        if (persisted) return persisted
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
        ctx.toolsStarted = true
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

      // 260902 cc freeform 工具（GPT-5 的 Responses custom tool）回来的 input 是裸字符串，
      // 落库前还原成对象形状——part.state.input 和 TUI/GUI 的渲染器都按对象写的，
      // 掉进 { value } 兜底会让 apply_patch 的 diff 视图整个渲染不出来。
      const toolInput = (value: unknown, name?: string): Record<string, any> =>
        isRecord(value) ? value : ((name ? Freeform.normalizeInput(name, value) : undefined) ?? { value })

      // 261020 Red 纯思考兜底的统一出口：静默超时与字符兜底都走这里——把思考提升为可见
      // 正文（用户至少看得到东西），置 finish="stop" 正常收尾（runLoop 下一轮读落库的
      // finish 决定 break）。why: docs/notes/implemented/bug-fix/2026-08-18-reasoning-stall-safety-net.md
      const promoteReasoning = Effect.fn("SessionProcessor.promoteReasoning")(function* (
        reason: "idle" | "maxChars",
      ) {
        if (ctx.reasoningStallTripped) return
        ctx.reasoningStallTripped = true
        slog.warn("reasoning.stall", {
          sessionID: ctx.sessionID,
          reason,
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
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        // 261013 Red A start event is not a content token. Empty deltas must not stop the content timer.
        if (compactionTiming) {
          compactionTiming.firstEventAt ??= performance.now()
          if (
            compactionTiming.firstContentAt === undefined &&
            (value.type === "text-delta" || value.type === "reasoning-delta") &&
            value.text.length > 0
          ) {
            compactionTiming.firstContentAt = performance.now()
          }
        }
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
            // 261020 Red 纯思考兜底（两档，见文件头注释与 note）：主判据是静默时长
            // （Stream.timeoutOrElse 处），这里只剩防无限流的字符兜底。
            if (!ctx.reasoningStallTripped && !ctx.stepProduced) {
              ctx.reasoningChars += value.text.length
              if (ctx.reasoningChars >= stall.maxChars) yield* promoteReasoning("maxChars")
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
            ctx.toolcalls[value.id] = { ...toolCall.call, inputEnded: true }
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            const toolCall = yield* ensureToolCall(value)
            const input = toolInput(value.input, value.name)
            if (!toolCall.call.inputEnded) {
            }
            yield* updateToolCall(value.id, value.name, (match) => ({
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

            // 261015 Red 失败预算由执行入口拦截，不能再弹 doom_loop 让确认动作重开同一死循环。
            if (ToolFailureGuard.count({
              sessionID: ctx.sessionID,
              parentID: ctx.assistantMessage.parentID,
              inputSignature: ToolFailureGuard.inputSignature(value.name, input),
            }) >= failureLimit) {
              ctx.toolFailureStopped = true
              return
            }

            // 260806 Red 取样范围从「当前助手消息内部」改为「本会话最近的 tool 分片（跨消息）」。
            // step-3.7-flash 实测会把同一个工具调用逐步重发 3–8 次，每步各是一条独立助手消息、
            // 每条只含一个 tool 分片，旧取样在单条消息内永远凑不满阈值，检测器一次都没触发过。
            const parts = MessageV2.recentToolParts(
              ctx.sessionID,
              DOOM_LOOP_THRESHOLD * 2,
              ctx.assistantMessage.parentID,
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)
            const inputJSON = RepeatToolReminder.inputKey(input)

            const outputKey = (part: (typeof recentParts)[number]) => {
              if (part.type !== "tool" || part.state.status !== "completed") return null
              const output = part.state.output ?? ""
              const reminder = part.state.metadata?.repeatReminder
              const suffix = typeof reminder === "string" ? `\n\n${reminder}` : undefined
              return suffix && output.endsWith(suffix) ? output.slice(0, -suffix.length) : output
            }

            // 260930 Red 当前调用已是 running；成功输出必须比较前三次完成结果，再拦下一次调用。
            const completedParts = parts.filter((part) => part.id !== toolCall.part.id).slice(-DOOM_LOOP_THRESHOLD)
            const completedLoop =
              completedParts.length === DOOM_LOOP_THRESHOLD &&
              completedParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status === "completed" &&
                  RepeatToolReminder.inputKey(part.state.input) === inputJSON,
              ) &&
              (() => {
                const outputs = completedParts.map(outputKey)
                return outputs[0] !== null && outputs.every((output) => output === outputs[0])
              })()

            const exactLoop =
              completedLoop ||
              (recentParts.length === DOOM_LOOP_THRESHOLD &&
                recentParts.every(
                  (part) =>
                    part.type === "tool" &&
                    part.tool === value.name &&
                    part.state.status !== "pending" &&
                    RepeatToolReminder.inputKey(part.state.input) === inputJSON,
                ) &&
                recentParts.some((part) => part.type === "tool" && part.state.status === "error"))

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
                  p.type === "tool" ? `${p.tool}\0${RepeatToolReminder.inputKey(p.state.input)}` : ""
                const pattern = cycleParts.slice(0, len).map(key)
                return cycleParts.every((p, i) => key(p) === pattern[i % len])
              })

            if (!exactLoop && !cycleLoop) return

            const cycleTools = cycleLoop
              ? [...new Set(cycleParts.flatMap((p) => (p.type === "tool" ? [p.tool] : [])))]
              : [value.name]

            // 260828 cc ctx.assistantMessage.agent 来自**落库的 assistant 消息**，可能指向一个已经
            // 删掉或改名的角色 —— 别名表只接得住内建的老名字，用户自建的 md agent 删掉后没人接。
            // 原来这里直接 `agent.permission`，被 Agent.get 那个「返回 Info」的类型谎言藏住了，真撞上
            // 就是 TypeError。回落到默认姿态的规则集：doom_loop 在 defaults 是 ask，回落只会更谨慎。
            const agent = (yield* agents.get(ctx.assistantMessage.agent)) ?? (yield* agents.defaultInfo())
            yield* permission
              .ask({
                permission: "doom_loop",
                patterns: cycleTools,
                sessionID: ctx.assistantMessage.sessionID,
                metadata: { tool: value.name, input },
                always: cycleTools,
                ruleset: agent.permission,
              })
              .pipe(
                // 261006 Red 静态规则 deny（典型：explore 子代理白名单 "*": deny 把 doom_loop 的
                // ask 档压成硬 deny，而子代理无人应答弹窗）原先一路炸到 halt —— 整个 step 失败、
                // assistant 消息挂 error、子代理临交报告被拦后整场交白卷（261006 crosspet 调研
                // 实测）。落成工具报错与普通权限拒绝对齐：模型看得见、可换路收尾。
                // 弹窗交互的 Rejected/Corrected 保持中断语义不放行——用户刚点了拒绝，
                // tap 放行后 SDK 仍会执行该调用，被拒工具不能真跑。冗余执行的结果由
                // completeToolCall 的 running 状态卫丢弃（守卫前提本就是「已确认结果相同」）。
                Effect.catchIf(
                  (error) => error instanceof Permission.DeniedError,
                  () =>
                    Effect.asVoid(
                      failToolCall(
                        value.id,
                        new Error(
                          `Tool call blocked by the doom-loop guard: the same ${value.name} call was already issued repeatedly with identical results. Do not repeat it. Use the results already in context or take a different approach, then continue your task.`,
                        ),
                      ),
                    ),
                ),
              )
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
                      () =>
                        Effect.succeed<{ part: MessageV2.FilePart; resize?: Image.ResizeReport }>({ part: attachment }),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(
                    Exit.succeed<{ part: MessageV2.FilePart; resize?: Image.ResizeReport }>({ part: attachment }),
                  ),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const succeeded = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const attachments = succeeded.map((item) => item.part)
            // 260822 cc 被缩过的图要告诉模型缩了多少（搬自官方 harness 6e17c20804）。
            // 不说的话模型看的是缩略图却以为是原图，它报出的任何像素尺寸/坐标都对不上原文件。
            // 这条路覆盖 read / webfetch / MCP / plugin / task 全部产图来源（webqa 截图走这里）。
            // 多张图时按序号编号，否则模型分不清说的是哪张。文案由 formatResizeNotice 统一
            // 产出且完全由尺寸推导——必须确定性，理由见该函数注释。
            const resizeNotices = succeeded
              .map((item, index) =>
                item.resize ? `[attachment #${index + 1}] ${Image.formatResizeNotice(item.resize)}` : undefined,
              )
              .filter((notice): notice is string => notice !== undefined)
            const output = {
              ...rawOutput,
              output: [
                rawOutput.output,
                ...(omitted === 0
                  ? []
                  : [
                      `[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
                    ]),
                ...resizeNotices,
              ].join("\n\n"),
              attachments: attachments.length ? attachments : undefined,
            }
            // 260814 Red 重复调用软层提醒（阈值 3/5/8 递进，纯建议不拦截）：同工具+同参
            // 连续调用即计数，不要求报错/同输出——轮询类只会走到这里，真空转另有上面
            // tool-call case 的 doom_loop 硬层弹窗兜底。贴 output 尾部，不伪装 user 角色。
            // 取舍与口径详见 repeat-tool-reminder.ts。
            if (toolCall && !RepeatToolReminder.EXCLUDED_TOOLS.has(toolCall.part.tool)) {
              const inputJSON = RepeatToolReminder.inputKey(toolCall.part.state.input)
              const priorParts = MessageV2.recentToolParts(ctx.sessionID, 24, ctx.assistantMessage.parentID).filter(
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
                output.metadata = { ...output.metadata, repeatReminder: reminder }
              }
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            // readToolCall 的返回值这里用不上，但它在 part 已不存在时会清掉 ctx.toolcalls，
            // 那个副作用要保留 —— 所以摘的是绑定不是调用
            yield* readToolCall(value.id)
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
            const usageStartedAt = compactionTiming ? performance.now() : undefined
            // 260903 cc 一次 add() 同时拿「完成快照」和「相对本 step 起点的补丁」。
            //   原先是 track() 与后面那句 patch(ctx.snapshot) 两次独立调用，各自跑一遍 add()，
            //   而两者之间工作树没有任何变化（中间只有内存记账和写会话库）。等价性推导与
            //   为什么 patch() 自己那个 add() 不能删，见 snapshot/index.ts 的 finish()。
            const stepSnapshot = yield* snapshot.finish(ctx.snapshot)
            const completedSnapshot = stepSnapshot.hash
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
              // 260816 Red: 峰谷定价按 step 完成时刻查价（记账定格，历史费用不随改价跳变）
              time: Date.now(),
            })
            if (!ctx.assistantMessage.summary) {
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
              // 260819 cc: context 是「这一刻上下文多大」，必须覆盖、不能像上面那样累加——
              // 累加出来是本轮所有 step 的提示词之和，长工具链下会是上下文的十几倍
              // （TUI 侧边栏原先拿 total 当上下文用，percentLabel 里那句 p > 200 加 ⚠
              // 就是这个问题被看见过但没改口径的痕迹）。
              context: usage.tokens.context,
              input: prevTokens.input + usage.tokens.input,
              output: prevTokens.output + usage.tokens.output,
              reasoning: prevTokens.reasoning + usage.tokens.reasoning,
              cache: {
                read: prevTokens.cache.read + usage.tokens.cache.read,
                write: prevTokens.cache.write + usage.tokens.cache.write,
                miss: (prevTokens.cache.miss ?? 0) + (usage.tokens.cache.miss ?? 0),
              },
            }
            // 260930 Red 未声明币种却产生费用：按 USD 入桶且每个模型只吵一次。models.dev 未标
            // 币种的模型费率全 0，能走到这里说明是自定义 provider 报了价却没声明 currency——
            // 「没声明就当美元」正是 260615 那起 ¥69.21→¥465.12 事故的默认值，兜底可以，必须留痕。
            if (!usage.currency && usage.cost > 0) {
              const warnKey = `${ctx.model.providerID}/${ctx.model.id}`
              if (!warnedMissingCurrency.has(warnKey)) {
                warnedMissingCurrency.add(warnKey)
                log.warn("step_finish.missing_currency", {
                  providerID: ctx.model.providerID,
                  modelID: ctx.model.id,
                  cost: usage.cost,
                })
              }
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
              // 260930 Red 币种与 cost 同时刻定格，session 行据此分桶记账（见 session.sql.ts）。
              // 未声明币种的模型若产生了费用，记账侧按 USD 入桶（warn 见上方）。
              ...(usage.currency ? { currency: usage.currency } : {}),
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = stepSnapshot.patch
              if (patch && patch.files.length) {
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
            if (compactionTiming && usageStartedAt !== undefined) {
              compactionTiming.usageMs += performance.now() - usageStartedAt
            }
            return
          }

          case "text-start":
            // 260710 Red 每个新 text part 重置 n-gram 检测器
            ctx.ngramDetector.reset()
            ctx.ngramTripped = false
            ctx.leakTripped = false
            ctx.leakScanner.reset()
            ctx.leakHold = undefined
            ctx.leakPending = ""
            // 260818 Red 有正文产出了，reasoning stall 检测解除
            ctx.stepProduced = true
            if (!ctx.assistantMessage.summary) {
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

          case "text-delta": {
            if (!ctx.currentText) return
            let delta = value.text
            while (true) {
              // 261014 Red 泄露标记暂扣态：锚点已命中、标记还没闭合。此间的增量既不进正文
              // 也不推客户端，攒到闭合 `]` 出现——丢掉标记本体、放行其余正文，并重新武装
              // 扫描器（同一个 part 里可能出现第二个标记）。
              if (ctx.leakHold !== undefined) {
                // 261027 Red 整块摘要只保存常量丢弃态，正文不累积、不在标题闭合后重新放行。
                if (InstructionEcho.summaryBodyAnchor(ctx.leakHold)) return
                const hold = ctx.leakHold + delta
                const release = InstructionEcho.releaseLeakHold(hold)
                if (release === undefined) {
                  ctx.leakHold = InstructionEcho.summaryBodyAnchor(hold) ?? hold
                  return
                }
                ctx.leakHold = undefined
                ctx.leakTripped = false
                ctx.leakScanner.reset()
                delta = release
                if (!delta) return
              }
              // 261014 Red 先扫描再落笔，命中后按锚点截断并立即下发纠偏。
              if (!ctx.leakTripped && ctx.leakScanner.feed(delta)) {
                ctx.leakTripped = true
                const cut = InstructionEcho.cutAtLeakAnchor(ctx.currentText.text + ctx.leakPending + delta)
                ctx.leakPending = ""
                const prefix = cut.text.startsWith(ctx.currentText.text) ? cut.text.slice(ctx.currentText.text.length) : ""
                ctx.currentText.text = cut.text
                ctx.leakHold = InstructionEcho.summaryBodyAnchor(cut.hold) ?? cut.hold
                if (prefix) yield* session.updatePartDelta({
                  sessionID: ctx.currentText.sessionID,
                  messageID: ctx.currentText.messageID,
                  partID: ctx.currentText.id,
                  field: "text",
                  delta: prefix,
                })
                yield* session.updatePart(ctx.currentText)
                slog.warn("leak.dcp-reminder", { sessionID: ctx.sessionID, textLen: ctx.currentText.text.length })
                delta = ""
                continue
              }
              break
            }
            // 261027 Red 候选摘要头先暂扣，避免跨分片命中前 PartDelta 已不可撤回。
            delta = ctx.leakPending + delta
            const pendingLength = Math.min(ctx.leakScanner.pendingLength, delta.length)
            ctx.leakPending = pendingLength ? delta.slice(-pendingLength) : ""
            delta = pendingLength ? delta.slice(0, -pendingLength) : delta
            if (!delta) return
            ctx.currentText.text += delta
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta,
            })
            // 260710 Red n-gram 重复检测：流式 delta 累积，发现重复立即中断
            if (!ctx.ngramTripped && ctx.ngramDetector.feed(delta)) {
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
            return
          }

          case "text-end":
            if (!ctx.currentText) return
            if (ctx.leakPending) {
              ctx.currentText.text += ctx.leakPending
              yield* session.updatePartDelta({
                sessionID: ctx.currentText.sessionID,
                messageID: ctx.currentText.messageID,
                partID: ctx.currentText.id,
                field: "text",
                delta: ctx.leakPending,
              })
              ctx.leakPending = ""
            }
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
            if (compactionTiming) compactionTiming.streamCompletedAt = performance.now()
            if (value.routedVia) ctx.assistantMessage.routedVia = value.routedVia
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        const cleanupStartedAt = compactionTiming ? performance.now() : undefined
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
          if (ctx.leakPending) {
            ctx.currentText.text += ctx.leakPending
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: ctx.leakPending,
            })
            ctx.leakPending = ""
          }
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
        if (compactionTiming && cleanupStartedAt !== undefined) {
          compactionTiming.cleanupMs += performance.now() - cleanupStartedAt
        }
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
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (
        streamInput: LLM.StreamInput,
        onResponse?: Effect.Effect<void>,
      ) {
        slog.info("process")
        ctx.needsCompaction = false
        let responseReceived = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        // 260728 Red 打捞只认本 step 真实注册的工具名，避免把讨论/日志里出现的
        // <tool_call> 字样当成真调用摘掉
        ctx.toolNames = new Set(Object.keys(streamInput.tools ?? {}))
        ctx.salvaged = []
        ctx.toolsStarted = false

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
            if (compactionTiming) compactionTiming.attempts++
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              // 261020 Red 静默兜底（主判据）：供应商在 idleMs 内不再吐任何分片，判定这一路流
              // 已卡住。计时只覆盖「等上游下一个分片」的时间——tap 里执行工具时上游并未拉取，
              // 长工具不会被误判成静默。有思考无正文 → 提升收尾；纯静默无思考 → 只结束流，
              // 交给 prompt.ts 的 producedNothing 恢复链（260808）出可见说明。
              Stream.timeoutOrElse({
                duration: stall.idleMs,
                orElse: () =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      if (!ctx.stepProduced && ctx.reasoningChars > 0) yield* promoteReasoning("idle")
                      return Stream.empty
                    }),
                  ),
              }),
              Stream.tap((event) =>
                Effect.gen(function* () {
                  if (onResponse && !responseReceived && isModelResponse(event)) {
                    responseReceived = true
                    yield* onResponse
                  }
                  const handlingStartedAt = compactionTiming ? performance.now() : undefined
                  yield* handleEvent(event)
                  if (compactionTiming && handlingStartedAt !== undefined) {
                    compactionTiming.eventHandlingMs += performance.now() - handlingStartedAt
                  }
                }),
              ),
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
                toolsStarted: () => ctx.toolsStarted,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
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
          if (ctx.toolFailureStopped || ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        compactionTiming,
        get message() {
          return ctx.assistantMessage
        },
        get stoppedByPermission() {
          return ctx.blocked
        },
        get stoppedByToolFailure() {
          return ctx.toolFailureStopped
        },
        guardToolCall,
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
    // 260708 Red wire Snippet.Service required by cleanup's snippet clear
    // 260820 cc 那个 construction 时获取 Snippet.Service 的写法已随双写摘除一起没了消费者，
    // 本文件不再 yield 它；这一层留着是因为下游（工具链）仍可能要求它，摘层是另一件事。
    Layer.provide(Snippet.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
