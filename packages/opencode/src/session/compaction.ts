import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import * as Log from "@redcode-ai/core/util/log"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context, Schema } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, level as overflowLevel, usable, type Level } from "./overflow"
import { serviceUse } from "@/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@redcode-ai/core/session-event"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
type Turn = {
  start: number
  end: number
  id: MessageID
}
// 260808 Red 文件清单（Pi 借鉴第 3 项）：压缩摘要附真实 read/modified 文件路径，
// 机械提取而非让模型凭记忆写 Relevant Files；跨压缩增量累积（标签解析回滚）。
const READ_TOOLS = new Set(["read"])
const WRITE_TOOLS = new Set(["edit", "write", "apply_patch"])

export function filePathsFrom(part: MessageV2.ToolPart): string[] {
  const input = part.state.input as Record<string, unknown>
  if (typeof input?.filePath === "string") return [input.filePath]
  if (part.tool === "apply_patch" && Array.isArray(input?.hunks)) {
    return input.hunks.flatMap((hunk) =>
      typeof (hunk as Record<string, unknown>)?.filePath === "string"
        ? [(hunk as Record<string, unknown>).filePath as string]
        : [],
    )
  }
  return []
}

export function collectFiles(messages: MessageV2.WithParts[]) {
  const read: string[] = []
  const modified: string[] = []
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const paths = filePathsFrom(part)
      if (!paths.length) continue
      const target = READ_TOOLS.has(part.tool) ? read : WRITE_TOOLS.has(part.tool) ? modified : undefined
      if (target) target.push(...paths)
    }
  }
  return { read: dedupe(read), modified: dedupe(modified) }
}

export function dedupe(paths: string[]) {
  return [...new Set(paths)]
}

export function parseFileTags(text: string) {
  const extract = (tag: string) =>
    dedupe(
      (text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
  return { read: extract("read-files"), modified: extract("modified-files") }
}

export function appendFileTags(summary: string, files: { read: string[]; modified: string[] }) {
  const tags = [
    files.read.length ? `<read-files>\n${files.read.join("\n")}\n</read-files>` : "",
    files.modified.length ? `<modified-files>\n${files.modified.join("\n")}\n</modified-files>` : "",
  ]
    .filter(Boolean)
    .join("\n")
  return tags ? `${summary}\n\n${tags}` : summary
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: MessageV2.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function buildPrompt(input: { previousSummary?: string; context: string[] }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join("\n\n")
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  /** 当前用量落在哪一档：ok / soft（只提示）/ prune（廉价裁剪）/ compact（真压缩） */
  readonly level: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<Level>
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  /** 返回本次实际释放的估算 token 数与被裁剪的 tool part 数；未启用或不足阈值时为 0 */
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<{ tokens: number; parts: number }>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    // 260729 Red 分级阈值查询（见 overflow.ts）：调用方据此在真正压缩之前先上廉价手段
    const level = Effect.fn("SessionCompaction.level")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflowLevel({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return { tokens: 0, parts: 0 }
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return { tokens: 0, parts: 0 }

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      if (pruned <= PRUNE_MINIMUM) return { tokens: 0, parts: 0 }
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          yield* session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
      // 260729 Red 报告实际释放量 —— 调用方据此判断"光 prune 就够了"，从而跳过这轮付费的
      // summarize 调用（见 prompt.ts 的 compact 分支）。原先返回 void，省下来多少无从得知。
      return { tokens: pruned, parts: toPrune.length }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      // 260813 Red compaction 前后 token 统计：assistant 消息的 tokens 字段是模型侧真实消耗，
      // 加总即"压缩前上下文有多大"；压缩完成后再算一次 after 回填 part，UI 分割线展示对比。
      const sumTokens = (msgs: MessageV2.WithParts[]) =>
        msgs.reduce(
          (sum, m) =>
            m.info.role === "assistant"
              ? sum +
                (m.info.tokens.input ?? 0) +
                (m.info.tokens.output ?? 0) +
                (m.info.tokens.reasoning ?? 0) +
                (m.info.tokens.cache.read ?? 0) +
                (m.info.tokens.cache.write ?? 0) +
                (m.info.tokens.cache.miss ?? 0)
              : sum,
          0,
        )
      const tokensBefore = sumTokens(input.messages)

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0, miss: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            // 260730 Karina 这条续跑消息以 role:"user" 落库，模型分不出它不是用户说的。
            // 线上实测（ses_04e354872ffe…，07-30 08:44:45 那条）：注入后连着四步思考写的是
            //   「用户说"继续"」→「用户要求继续做下一步」→「用户要求"继续"，说明他认可前面的
            //   改动方向」→「用户说"先commit再测"」
            // 最后那句用户一个字都没发过 —— 它先把这条当成用户发言，再顺着编出后续指令。
            //
            // role 保持 user 不动：对话必须以 user 轮结尾才能续跑，中途插 system 消息各家
            // provider 支持度不一。改的是**文案**，三件事：
            //   1. 开头就声明这不是用户发言（[System notice] 前缀与 xml-tool-call /
            //      text-loop-detection 的注入保持一致，instruction-echo 也照这个前缀剥离复述）
            //   2. 带上本轮的原始请求做锚点 —— 压缩会把"用户到底要什么"摘没，只留一句含糊的
            //      "continue"，模型就会从摘要里最显眼的旧状态接着跑
            //   3. 明确"已完成的工作在摘要里，别重头再来"，并且默认倾向汇报而不是继续
            const anchor = (() => {
              for (let i = input.messages.length - 1; i >= 0; i--) {
                const m = input.messages[i]
                if (m.info.role !== "user") continue
                const own = m.parts
                  .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
                  .map((p) => (p.type === "text" ? p.text : ""))
                  .join("\n")
                  .trim()
                if (own) return own.length > 600 ? own.slice(0, 600) + "…" : own
              }
              return undefined
            })()
            const text = [
              "[System notice] This message was NOT sent by the user — the user has said nothing since your last turn. The conversation was automatically compacted because it grew too long; this is the follow-up prompt.",
              input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. Media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files."
                : "",
              anchor ? "The user's actual request for this turn was:\n" + anchor : "",
              "The summary above already records what you completed so far. Do not restart from the beginning, and do not treat this notice as a new instruction. If the work is already done, report the result to the user and stop. Continue only if concrete steps remain.",
            ]
              .filter(Boolean)
              .join("\n\n")
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        const summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
            (item) => item.info.id === msg.id,
          ) ?? {
            info: msg,
            parts: [],
          },
        )
        // 260808 Red 文件清单追加（Pi 借鉴第 3 项）：机械提取被压缩消息里真实 read/write
        // 过的文件，与上次摘要标签合并后 append 到摘要文本 —— 压缩后模型不用重新探索
        // 已读文件，也不依赖模型在 Relevant Files 里凭记忆写路径。
        const priorFiles = parseFileTags(previousSummary ?? "")
        const fresh = collectFiles(selected.head)
        const files = {
          read: dedupe([...priorFiles.read, ...fresh.read]),
          modified: dedupe([...priorFiles.modified, ...fresh.modified]),
        }
        if (files.read.length || files.modified.length) {
          const tagged = appendFileTags(summary ?? "", files)
          const parts =
            (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
              (item) => item.info.id === msg.id,
            )?.parts ?? []
          const textPart = parts.findLast((part) => part.type === "text" && !!part.text.trim())
          if (textPart && textPart.type === "text") {
            yield* session.updatePart({
              ...textPart,
              text: tagged,
            })
          }
        }
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Compaction.Ended, {
            sessionID: input.sessionID,
            timestamp: DateTime.makeUnsafe(Date.now()),
            text: summary ?? "",
            include: selected.tail_start_id,
          })
        }
        // 260813 Red 回填 compaction 前后 token，供 UI 分割线展示对比。
        // 注意展开旧 compactionPart 会覆盖掉前面已更新的 tail_start_id，必须带回来。
        if (compactionPart) {
          const after = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const tokensAfter = sumTokens(after)
          if (compactionPart.tokens_before !== tokensBefore || compactionPart.tokens_after !== tokensAfter) {
            yield* session.updatePart({
              ...compactionPart,
              tail_start_id: selected.tail_start_id ?? compactionPart.tail_start_id,
              tokens_before: tokensBefore,
              tokens_after: tokensAfter,
            })
          }
        }
        yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
        yield* plugin.trigger("compact.post", { sessionID: input.sessionID }, {}).pipe(Effect.catch(() => Effect.void))
      }
      return result
    }) as Interface["process"]

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          reason: input.auto ? "auto" : "manual",
        })
      }
    })

    return Service.of({
      isOverflow,
      level,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export * as SessionCompaction from "./compaction"
