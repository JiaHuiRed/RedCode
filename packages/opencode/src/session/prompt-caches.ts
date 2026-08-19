import type { ModelMessage } from "ai"
import * as Log from "@redcode-ai/core/util/log"

const log = Log.create({ service: "prompt-caches" })

type SystemCache = { sessionID: string; modelKey: string; skills: string | undefined; env: string[]; instructions: string[] }
type MessagePinCache = { sessionID: string; messages: Map<string, unknown[]> }
type ModelMessagesCache = { sessionID: string; modelKey: string; messages: ModelMessage[] }
type ToolCache = { sessionID: string; defs: Map<string, { description: string; inputSchema: unknown }> }
type PromptCacheState = {
  system: Map<string, Map<string, SystemCache>>
  msgPin: Map<string, MessagePinCache>
  modelMsgs: Map<string, Map<string, ModelMessagesCache>>
  tools: Map<string, ToolCache>
  // 260819 cc audit：会话最后一次被使用的时刻，供 TTL/数量回收用。跟四个缓存放同一个
  // globalThis 槽 —— 分开放会让「模块被实例化多次」时各实例按各自的视图回收共享的缓存。
  seen: Map<string, number>
}

// 260617 Red session-level caches: snapshot once per session to stabilize system prompt for prefix caching.
// Without caching, instruction.system() re-reads disk every turn — any file change (MEMORY.md, AGENTS.md,
// skill files) mutates the system prompt and invalidates DeepSeek prefix cache mid-session.
// 260620 Red use globalThis for cache storage — bun compile may instantiate module multiple times,
// causing module-level `let` to be duplicated across instances. globalThis ensures single shared cache.
// 260811 cc audit R4: 从 prompt.ts 抽出为独立模块，让 compact 边界的"分代结算"可以被
// 会话循环调用而不制造循环依赖。
const globalWithCaches = globalThis as typeof globalThis & { __rc_prompt_caches?: PromptCacheState }
export const PromptCaches = (globalWithCaches.__rc_prompt_caches ??= {
  system: new Map<string, Map<string, SystemCache>>(),
  msgPin: new Map<string, MessagePinCache>(),
  modelMsgs: new Map<string, Map<string, ModelMessagesCache>>(),
  // 260706 Red cache tool definitions (description+inputSchema) for prefix stability.
  // describeSkill()/describeTask() rebuild tool descriptions from disk every step via Glob.scan;
  // if skill/agent lists change mid-session the tool schema JSON mutates → prefix cache breaks.
  // 260804 Red tools cache is model-agnostic (descriptions come from disk, not model) — no modelKey.
  tools: new Map<string, ToolCache>(),
  seen: new Map<string, number>(),
})
// 老实例先建好对象、新实例只拿到引用时补齐字段（`??=` 只认整个对象存不存在）
PromptCaches.seen ??= new Map<string, number>()

// 260811 cc audit R4 分代结算（哥哥拍板：缓存优先）：
// msgPin/modelMsgs 把已发送的消息钉死在首次快照上——这是前缀缓存的命根子，但也意味着
// 一切对旧消息的改写（compaction prune 打的 compacted 标记、DCP 的压缩改写）在平时
// 全部被钉回去、不生效。这不是 bug 而是取舍：改写必然从改写点起炸掉前缀缓存。
// 结算点选在 compact 边界——摘要重写反正要重建缓存，累积改写搭同一班车等于免费：
//   soft(0.6)  提醒，不动前缀
//   prune(0.8) 只记账（标记入库，prompt 仍走钉死快照）
//   compact    结算：丢弃 msgPin/modelMsgs → 下一轮从库里重新钉（prune 标记、DCP 改写
//              一并生效），内存里的整套快照双份同时释放
// system/tools 两个缓存与消息历史无关，不参与结算。
export function settlePromptCaches(sessionID: string, reason: string) {
  let dropped = 0
  const msgPin = PromptCaches.msgPin.get(sessionID)
  if (msgPin) {
    dropped += msgPin.messages.size
    PromptCaches.msgPin.delete(sessionID)
  }
  const modelMsgs = PromptCaches.modelMsgs.get(sessionID)
  if (modelMsgs) {
    dropped += Array.from(modelMsgs.values()).reduce((total, cache) => total + cache.messages.length, 0)
    PromptCaches.modelMsgs.delete(sessionID)
  }
  if (dropped > 0) log.info("settled", { sessionID, reason, droppedEntries: dropped })
  return dropped
}

// 260819 cc audit：会话维度此前零回收。settlePromptCaches 只删 msgPin/modelMsgs，
// system/tools 没有任何删除点，全仓也没有订阅 Session.Event.Deleted 做缓存清理——
// 四个 Map 按会话数只增不减。CLI 无影响（进程即会话），但 GUI sidecar 与 `serve`
// 是长驻多会话进程：每个会话留下 system（skills+env+instructions 全文，按模型再分桶）、
// tools（全部工具的 description+inputSchema）、以及尚未在 compact 边界结算掉的
// msgPin/modelMsgs（整段被钉死的消息历史，长会话可达数 MB）。
//
// 回收口径用「冷」而不是「删」：会话被显式删除是少数情况，绝大多数只是不再被 prompt。
//   TTL 为主：超过 1 小时没被使用即回收。此时 provider 侧的前缀缓存（分钟量级）早已过期，
//            重建不会多花一分钱，纯赚内存。
//   数量为辅：只挡突发。回收活跃会话是有代价的——丢 msgPin/modelMsgs 等于让 DCP 攒下的
//            改写一次性生效、整条前缀从最早改写处重写（见上面分代结算那段），所以上限取
//            得宽松，单人使用下一小时内触碰超过 32 个会话不现实。
//   两条都命中不了的极端情况宁可留着内存，也不主动去打前缀缓存。
const SESSION_TTL_MS = 60 * 60 * 1000
const MAX_SESSIONS = 32

/** 把一个会话从全部四个缓存里彻底摘掉。settle 只管 msgPin/modelMsgs，这里连 system/tools 一起。 */
export function dropSession(sessionID: string) {
  const dropped =
    settlePromptCaches(sessionID, "evict") +
    (PromptCaches.system.delete(sessionID) ? 1 : 0) +
    (PromptCaches.tools.delete(sessionID) ? 1 : 0)
  PromptCaches.seen.delete(sessionID)
  return dropped
}

/**
 * 每轮 prompt 构造时调用一次，登记本会话的活跃时刻并顺手回收冷会话。
 * 惰性清扫而非定时器：条目数是「近期会话数」量级（个位到几十），每轮扫一遍代价可忽略，
 * 也不必操心 timer 的生命周期与 unref。
 */
export function touchSession(sessionID: string, now = Date.now()) {
  // 重新插入把自己挪到末尾——Map 保插入序，于是从头遍历就是「从最冷到最热」
  PromptCaches.seen.delete(sessionID)
  PromptCaches.seen.set(sessionID, now)

  const evicted: string[] = []
  for (const [id, at] of [...PromptCaches.seen]) {
    if (id === sessionID) continue
    if (now - at <= SESSION_TTL_MS) break // 后面的只会更热
    // dropSession 自己会把它从 seen 里摘掉；返回 0 表示这个会话只有活跃记录、没缓存数据，
    // 摘掉但不记进 evicted（没释放东西就别谎报释放）
    if (dropSession(id) > 0) evicted.push(id)
  }
  while (PromptCaches.seen.size > MAX_SESSIONS) {
    const oldest = PromptCaches.seen.keys().next().value
    if (oldest === undefined || oldest === sessionID) break
    if (dropSession(oldest) > 0) evicted.push(oldest)
  }
  if (evicted.length > 0) log.info("evicted", { sessions: evicted.length, live: PromptCaches.seen.size })
  return evicted
}
