import type { ModelMessage } from "ai"
import { Schema } from "effect"
import { NonNegativeInt } from "@redcode-ai/core/schema"
import { Token } from "@/util/token"
import { countModelMessageContent, imageRequestTokens } from "./image-tokens"
import { MAX_SESSIONS, SESSION_TTL_MS, sessionEvictor } from "@/util/session-evictor"

// 260820 cc 上下文构成快照：把「这一刻发出去的请求由什么组成」记下来，供 UI 查看。
//
// 为什么不读 PromptCaches：那里缓存的是 system 的**原料**（env/instructions/skills），
// 不是最终数组——runLoop 每轮还要往 system 上追加日期、WORK RULES、按模型家族分支的
// 若干锚、canary、DCP 说明。拿原料拼一遍等于把 runLoop 的拼装逻辑复刻一份在读取侧，
// 加一条锚漏一处、数字就悄悄偏。所以在**真正发出去的那一刻**记账：system/tools/messages
// 三份都取 handle.process 实际收到的那几个值。
//
// 为什么不用 /api/session/:id/context：那个端点读 session_message 表，而该表的会话内容
// 写入在 688c31cf（摘除双写）之后就停了——实测 live 库 782 行里只有 model-switched 501
// + agent-switched 281，一条对话都没有。它现在只是个空壳。
//
// 只留最后一轮、只在内存：这是「现在窗口里装了什么」，不是历史指标，重启后下一轮请求
// 就重新有值。回收接 session-evictor（与 prompt-caches/prefix-shape 同一套）。
//
// 成本：system 段只做 length/4，免费；tools 每轮按工具序列化一次（PrefixShape.capture
// 本就整体序列化一次，这里是同一批数据换成逐个）；messages 靠 WeakMap 按**对象引用**
// 记忆——modelMsgs 的前缀是钉死的同一批对象（prompt.ts 的 stabilizedMsgs 直接展开缓存
// 数组），所以稳态下只算新增的那几条，不是每轮全量。

export const Segment = Schema.Struct({
  label: Schema.String.annotate({ description: "Human-readable name of this slice of the prompt" }),
  tokens: NonNegativeInt.annotate({ description: "Estimated tokens (chars / 4)" }),
}).annotate({ identifier: "ContextSegment" })
export type Segment = Schema.Schema.Type<typeof Segment>

export const Info = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  time: NonNegativeInt.annotate({ description: "When this request was assembled" }),
  total: NonNegativeInt.annotate({ description: "system + tools + messages" }),
  system: Schema.Struct({
    tokens: NonNegativeInt,
    segments: Schema.Array(Segment).annotate({ description: "One entry per system-prompt block, largest first" }),
  }),
  tools: Schema.Struct({
    count: NonNegativeInt,
    tokens: NonNegativeInt,
    top: Schema.Array(Segment).annotate({ description: "Most expensive tool schemas, largest first" }),
  }),
  messages: Schema.Struct({
    count: NonNegativeInt,
    tokens: NonNegativeInt,
    byRole: Schema.Array(Segment).annotate({ description: "Conversation tokens grouped by role, largest first" }),
  }),
}).annotate({ identifier: "ContextSnapshot" })
export type Info = Schema.Schema.Type<typeof Info>

const store = new Map<string, Info>()
const evictor = sessionEvictor({
  ttlMs: SESSION_TTL_MS,
  max: MAX_SESSIONS,
  drop: (key) => (store.delete(key) ? 1 : 0),
})

/** 每条 ModelMessage 的 token 数，按对象引用记忆——钉死的前缀不重算 */
const memo = new WeakMap<object, { text: number; images: number }>()

const LABEL_MAX = 48
const TOP_TOOLS = 8

/**
 * 给一段 system 起个名字。取首行、剥掉 markdown/项目符号；`<env>` 这类整块包裹的取标签名。
 * 刻意不在 system 拼装处逐段标注——那是几十个 push 散落在 runLoop 里，标注等于每加一段
 * 都要记得同步一次，漏一处就是个没名字的段。首行本来就是各段的自述。
 */
export function label(text: string): string {
  const first = text.trimStart().split("\n", 1)[0]?.trim() ?? ""
  const tag = /^<([a-z][a-z0-9_-]*)>\s*$/i.exec(first)
  if (tag) return tag[1]!
  const cleaned = first.replace(/^[▸#>*\-\s]+/, "").trim()
  if (!cleaned) return "(empty)"
  return cleaned.length > LABEL_MAX ? cleaned.slice(0, LABEL_MAX - 1) + "…" : cleaned
}

// 260828 cc：原来是 Token.estimate(JSON.stringify(content))，而图片在 ModelMessage
// 里是内联 data URL —— 一张 400KB 的 JPEG 会被记成约 13 万 token，用量面板的
// "messages 占多少"于是被一张截图完全带偏。按 image-tokens 的路由投影计价。
//
// 缓存存的是**路由无关**的事实（文本 token 数 + 图片张数），价钱在读的时候按当前
// 路由现算 —— 否则换模型之后 WeakMap 里留的是上一条路由的价（形态取自 DSH 的
// route-priced surface：节点存事实，measure() 时定价）。
function messageFacts(message: ModelMessage): { text: number; images: number } {
  const cached = memo.get(message)
  if (cached !== undefined) return cached
  const content = message.content
  const facts =
    typeof content === "string"
      ? { text: Token.estimate(content), images: 0 }
      : countModelMessageContent(content)
  memo.set(message, facts)
  return facts
}

function messageTokens(message: ModelMessage, providerID: string): number {
  const facts = messageFacts(message)
  return facts.text + facts.images * imageRequestTokens({ providerID })
}

const bySize = (a: Segment, b: Segment) => b.tokens - a.tokens

export function record(input: {
  sessionID: string
  providerID: string
  modelID: string
  system: string[]
  tools: Record<string, unknown>
  messages: ModelMessage[]
  now?: number
}): Info {
  const segments = input.system
    .map((text) => ({ label: label(text), tokens: Token.estimate(text) }))
    .filter((item) => item.tokens > 0)
    .sort(bySize)
  const systemTokens = segments.reduce((sum, item) => sum + item.tokens, 0)

  const toolCosts = Object.keys(input.tools)
    .map((name) => ({
      label: name,
      tokens: Token.estimate(JSON.stringify({ name, def: input.tools[name] }) ?? ""),
    }))
    .sort(bySize)
  const toolTokens = toolCosts.reduce((sum, item) => sum + item.tokens, 0)

  const roles = new Map<string, number>()
  let messageTotal = 0
  for (const message of input.messages) {
    const tokens = messageTokens(message, input.providerID)
    messageTotal += tokens
    roles.set(message.role, (roles.get(message.role) ?? 0) + tokens)
  }
  const byRole = [...roles].map(([role, tokens]) => ({ label: role, tokens })).sort(bySize)

  const snapshot: Info = {
    providerID: input.providerID,
    modelID: input.modelID,
    time: input.now ?? Date.now(),
    total: systemTokens + toolTokens + messageTotal,
    system: { tokens: systemTokens, segments },
    tools: { count: toolCosts.length, tokens: toolTokens, top: toolCosts.slice(0, TOP_TOOLS) },
    messages: { count: input.messages.length, tokens: messageTotal, byRole },
  }
  store.set(input.sessionID, snapshot)
  evictor.touch(input.sessionID)
  return snapshot
}

export function get(sessionID: string): Info | undefined {
  return store.get(sessionID)
}

/** 测试钩子：清空进程内快照，避免用例之间互相污染 */
export function reset() {
  store.clear()
  evictor.clear()
}

export * as ContextSnapshot from "./context-snapshot"
