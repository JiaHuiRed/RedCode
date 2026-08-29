import type { ModelMessage } from "ai"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Global } from "@redcode-ai/core/global"
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
// 只留最后一轮：这是「上一次请求发出去时窗口里装了什么」，不是历史序列。内存那份接
// session-evictor 回收（与 prompt-caches/prefix-shape 同一套）。
//
// 260829 cc 加了一层落盘。原本纯内存的代价：打开任何一个本进程没发过请求的会话——重启后、
// 或刚被 evictor 回收的——都只剩「暂无」，UI 掉回客户端估算，而估算先天看不见 system 与
// tool schema，「其他」恒等于整包前缀（实测一个新会话是 99.5%）。前缀本身是稳态的，上一轮
// 的构成对「这个会话大概装着什么」是个好答案，远好过一条废条。
//
// **为什么是裸 fs 而不是 Storage 服务**：试过，走不通。record 的调用点在 runLoop 里，而
// prompt.ts 的 `loop` 被显式标注成 `Effect.Effect<MessageV2.WithParts>`（零依赖契约），
// 在里面拿 Storage.Service 会把依赖漏进那个类型；改成在 SessionPrompt 的 layer 链上
// `Layer.provide(Storage.defaultLayer)` 之后，另外三个测试的 layer 组合塌成
// `Layer<unknown, unknown, unknown>` —— 那条链已经顶到 TS 推断上限，再加一个 provide 就爆，
// 位置放哪都一样（链首链尾都试过）。修它等于重构整张 layer 图。
// 而 Storage 的目录是 `path.join(Global.Path.data, "storage")`，**进程级常量、不按项目算**，
// 所以纯模块自己算得出同级路径。这里刻意用**另一个目录**而不是写进 storage/ 树：那棵树有
// 迁移与可重入锁，多一个绕过它们的写入者是隐患；而这份东西本质是缓存，丢了下一轮就重建。
//
// 写入是 fire-and-forget、错误全吞：快照是可有可无的观测数据，不该让写盘失败打断请求。
// 逐 step 落盘没有另做 flush 合并——JSON 只有几 KB，紧接着就是一次几秒的 LLM 请求。
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
  save(input.sessionID, snapshot)
  return snapshot
}

const DISK_MAX = 500
const PRUNE_EVERY = 200
let writes = 0

const dir = () => path.join(Global.Path.data, "context-snapshot")
const file = (sessionID: string) => path.join(dir(), `${sessionID}.json`)

/** 一份文件几 KB，但会话数无界——每 200 次写做一次修剪，按 mtime 只留最新的 500 份。 */
async function prune() {
  const base = dir()
  const names = await fs.readdir(base).catch(() => [] as string[])
  if (names.length <= DISK_MAX) return
  const stats = await Promise.all(
    names.map(async (name) => ({ name, at: await fs.stat(path.join(base, name)).then((x) => x.mtimeMs, () => 0) })),
  )
  const stale = stats.sort((a, b) => b.at - a.at).slice(DISK_MAX)
  await Promise.all(stale.map((x) => fs.rm(path.join(base, x.name), { force: true }).catch(() => {})))
}

function save(sessionID: string, snapshot: Info) {
  void (async () => {
    try {
      await fs.mkdir(dir(), { recursive: true })
      await fs.writeFile(file(sessionID), JSON.stringify(snapshot))
      if (++writes % PRUNE_EVERY === 0) await prune()
    } catch {
      // 观测数据，写不进去就算了
    }
  })()
}

export function get(sessionID: string): Info | undefined {
  return store.get(sessionID)
}

/** 先读内存，miss 再回盘；回盘命中顺手暖回内存，免得同一会话每次查看都读一次文件。 */
export const load = (sessionID: string) =>
  Effect.promise(async (): Promise<Info | undefined> => {
    const cached = store.get(sessionID)
    if (cached) return cached
    try {
      const text = await fs.readFile(file(sessionID), "utf8")
      const found = JSON.parse(text) as Info
      store.set(sessionID, found)
      evictor.touch(sessionID)
      return found
    } catch {
      return undefined
    }
  })

/** 测试钩子：清空**进程内**快照，避免用例之间互相污染。盘上那份按 sessionID 分文件，
 * 测试用的 id 各不相同、互不干扰，不动。 */
export function reset() {
  store.clear()
  evictor.clear()
}

export * as ContextSnapshot from "./context-snapshot"
