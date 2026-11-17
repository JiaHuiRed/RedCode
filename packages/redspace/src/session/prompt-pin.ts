import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "@redcode-ai/core/global"

// 261029 Red 会话级 prompt 钉住的磁盘延伸：把冷组装定型的工具定义与 MCP guide 落盘，
// 重启续接时优先恢复，让「重启后重建的前缀」与「未重启时钉住的前缀」逐字节一致。
//
// 动机（261029 实测 ses_ffe5e79dfe72dffepQHyeFoM1yyZjy）：关闭 exe 35 秒后重进同一会话，
// 供应商报告的缓存命中率 99.7% → 0，321k token 全价重建。根因不是供应商缓存过期——
// 进程内钉住（PromptCaches.tools / SystemCache.mcpGuide）随进程消失，续接重组时 MCP
// 工具定义与自述已随服务器升级（jcodemunch 当天更新，system 段 +51B / tools 段 +64B），
// 供应商逐字节比对失败。本文件把 prompt-caches 的会话内钉住语义原样延伸到磁盘：
//   - settle（压缩结算）不动它——system/tools 本就不参与结算，见 prompt-caches.ts 注释
//   - 会话被 evictor 回收时经 dropSession 一并删除
// history 投影漂移（msgPin/modelMsgs 侧）是独立问题，不在本文件范围。

// 261029 Red v2：v1 落盘的 inputSchema 是 AI SDK Schema 对象序列化后的残缺对象
// （丢 Symbol 标记只剩 { jsonSchema: ... }），消费端重建会发出双层嵌套 schema。
// v2 起落盘纯 JSON Schema 数据（见 extractSchema），旧格式靠版本号整体弃用回退现算。
//
// 261117 Red v3（0.19.1 审计 F-07）：v2 只钉工具定义，消息侧仍只在内存。冷恢复时
// msgPin 为空 → 历史消息重新走 messages.transform，而插件（memory-recall）按会话 seen
// 去重、非幂等 → 同一条消息两次 pin 长度不同（实测 1776 vs 80）→ 历史中段改写、
// 整段 prefix 全价重建。v3 把已钉住的消息 parts 一并落盘，冷恢复优先复用。
// 决策：docs/notes/implemented/feature/2026-11-17-prompt-pin-messages.md
const VERSION = 3

// 单会话消息快照硬上限。msgPin 钉的是完整 parts（含 tool 结果），DB 实测单会话
// part 总量最高 289MB；原样落盘 × DISK_MAX(500) 会吃掉 GB 级磁盘。超限只保留最近的
// 消息——它们正是被插件追加重写、最需要跨进程稳定的那批。
const MESSAGE_BYTES_MAX = 512 * 1024

export interface Pin {
  version: number
  sessionID: string
  savedAt: number
  tools: Record<string, { description: string; inputSchema: unknown }>
  mcpGuide?: string
  /** 已钉住消息的 parts 快照，按消息 ID 索引。冷恢复灌回 msgPin，避免重新 transform。 */
  messages?: Record<string, unknown[]>
  /** 快照对应的 native compaction 版本；不匹配时整份消息快照作废。 */
  nativeRevision?: string
}

// 261029 Red 路径可覆盖（测试隔离）：每次取值而非模块加载时定，照 prefix-probe 的模式
const dir = () => process.env["REDCODE_PROMPT_PIN_DIR"] || path.join(Global.Path.data, "prompt-pin")

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

const file = (sessionID: string) => path.join(dir(), `${sanitize(sessionID)}.json`)

// 写盘串成一条链：save/drop 是异步 fire-and-forget，但保持彼此顺序；flush 供测试排空
let writeChain: Promise<void> = Promise.resolve()
export const flush = () => writeChain

/**
 * 同步读会话 pin。缺失/损坏/版本或会话不匹配都返回 undefined——调用方回退现算，
 * 行为与本特性部署前完全一致。只在冷缓存轮次被调用（cachedTools/cachedSystem 命中时
 * 短路），不在热路径上。
 */
export function load(sessionID: string): Pin | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(file(sessionID), "utf-8")
  } catch {
    // 无 pin 是常态（新会话），读失败等同无 pin
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Pin
    if (parsed?.version !== VERSION || parsed.sessionID !== sessionID) return undefined
    // 261029 Red 语法合法但结构损坏（tools 为 null/数组/条目缺字段）同样弃用回退：
    // 否则坏 pin 流到消费端的 Object.entries/overlay 上炸掉冷启动轮，违背「损坏一律回退」
    if (
      typeof parsed.tools !== "object" ||
      parsed.tools === null ||
      Array.isArray(parsed.tools) ||
      !Object.values(parsed.tools).every(
        (t) => typeof t === "object" && t !== null && typeof t.description === "string" && "inputSchema" in t,
      )
    )
      return undefined
    // 261117 Red 消息快照是可选增量：结构不对就单独丢掉，不影响工具 pin 的复用
    if (parsed.messages !== undefined) {
      if (typeof parsed.messages !== "object" || parsed.messages === null || Array.isArray(parsed.messages))
        delete parsed.messages
      else if (!Object.values(parsed.messages).every((parts) => Array.isArray(parts))) delete parsed.messages
    }
    return parsed
  } catch {
    // 损坏的 pin 直接弃用：下次冷组装会用新内容覆盖它
    return undefined
  }
}

// 261029 Red inputSchema 运行时是 AI SDK Schema 对象（Symbol 标记 + getter + validate），
// 直接 JSON.stringify 会丢标记只剩 { jsonSchema: ... } 残缺对象——消费端 prepareTools 的
// asSchema() 分派会把它当函数调用直接 TypeError。落盘前提取纯 JSON Schema 数据；
// 已是裸数据的（测试构造/非 SDK 形态）原样保留。
function extractSchema(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "jsonSchema" in value) {
    const s = (value as { jsonSchema: unknown }).jsonSchema
    if (typeof s === "object" && s !== null) return s
  }
  return value
}

// 261117 Red 消息快照按体积裁剪：从最近的消息往前累计，超过上限就停。
// 至少保留一条（单条超限也比完全不复用强，冷恢复该条仍稳定）。
function packMessages(messages: Map<string, unknown[]>): Record<string, unknown[]> | undefined {
  const entries = [...messages]
  if (!entries.length) return undefined
  const kept: [string, unknown[]][] = []
  let bytes = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    bytes += Buffer.byteLength(JSON.stringify(entries[index][1]))
    if (bytes > MESSAGE_BYTES_MAX && kept.length) break
    kept.push(entries[index])
  }
  return Object.fromEntries(kept.reverse())
}

export function save(input: {
  sessionID: string
  tools: Map<string, { description: string; inputSchema: unknown }>
  mcpGuide: string | undefined
  messages?: Map<string, unknown[]>
  nativeRevision?: string
}): void {
  const messages = input.messages ? packMessages(input.messages) : undefined
  const pin: Pin = {
    version: VERSION,
    sessionID: input.sessionID,
    savedAt: Date.now(),
    tools: Object.fromEntries(
      [...input.tools].map(([k, t]) => [k, { description: t.description, inputSchema: extractSchema(t.inputSchema) }]),
    ),
    ...(input.mcpGuide !== undefined ? { mcpGuide: input.mcpGuide } : {}),
    ...(messages !== undefined ? { messages } : {}),
    ...(input.nativeRevision !== undefined ? { nativeRevision: input.nativeRevision } : {}),
  }
  writes++
  // 261029 Red prune 判定在入队时定格：队列任务运行时再读全局会拿到终值，
  // 集中排队恰好凑满 PRUNE_EVERY 时会连环触发目录扫描
  const shouldPrune = writes % PRUNE_EVERY === 0
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(dir(), { recursive: true })
      await fsp.writeFile(file(input.sessionID), JSON.stringify(pin), "utf-8")
      if (shouldPrune) await prune()
    })
    .catch(() => {}) // 写失败不影响请求主路径：最坏下次重启没有 pin，多付一次全价重建（即部署前行为）
}

/** 会话被 evictor 回收时清理 pin。失败留孤儿文件无害：同 id 未来 save 会覆盖。 */
export function drop(sessionID: string): void {
  writeChain = writeChain
    .then(() => fsp.rm(file(sessionID), { force: true }))
    .catch(() => {}) // 回收路径上的清理，失败不追溯
}

/**
 * 261117 Red compaction 结算：只丢消息快照，工具定义与 MCP guide 继续复用。
 * 压缩改写必须在下一轮生效——消息快照若留在磁盘，冷恢复会把它钉回去，
 * 压缩白做且可能撑爆上下文预算。settle 语义见 prompt-caches.ts。
 */
export function dropMessages(sessionID: string): void {
  writeChain = writeChain
    .then(async () => {
      const pin = load(sessionID)
      if (!pin?.messages) return
      delete pin.messages
      delete pin.nativeRevision
      pin.savedAt = Date.now()
      await fsp.writeFile(file(sessionID), JSON.stringify(pin), "utf-8")
    })
    .catch(() => {}) // 清失败最坏是冷恢复钉回旧快照，与部署前行为一致
}

// 261029 Red 孤儿修剪：用户删除会话不经过 dropSession，pin 会残留。照 context-snapshot
// 的 mtime 修剪模式：每 PRUNE_EVERY 次 save 检查一次，按 mtime 只留最新 DISK_MAX 份。
const DISK_MAX = 500
const PRUNE_EVERY = 200
let writes = 0

async function prune() {
  // 目录尚不存在视为无可修剪
  const names = await fsp.readdir(dir()).catch(() => [] as string[])
  if (names.length <= DISK_MAX) return
  const stats = await Promise.all(
    names.map(async (name) => ({
      name,
      at: await fsp.stat(path.join(dir(), name)).then(
        (x) => x.mtimeMs,
        () => 0,
      ),
    })),
  )
  const stale = stats.sort((a, b) => b.at - a.at).slice(DISK_MAX)
  await Promise.all(stale.map((x) => fsp.rm(path.join(dir(), x.name), { force: true }).catch(() => {})))
}

export * as PromptPin from "./prompt-pin"
