import * as fs from "fs"
import * as fsp from "fs/promises"
import * as path from "path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { Global } from "@redcode-ai/core/global"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import * as Log from "@redcode-ai/core/util/log"
import { MAX_SESSIONS, SESSION_TTL_MS, sessionEvictor } from "@/util/session-evictor"

// 260810 cc audit R2: "写前已读"守卫（上游 FileTime 的移植，比对口径从墙钟改为 mtime）。
// write/edit 此前不校验文件是否被本会话 read 过、也不比对改动时间——IDE 手改、git 操作、
// 并行 subagent 落盘的内容会被 agent 拿着旧文整个推平。这里按 (sessionID, 绝对路径) 记录
// read 时刻的文件 mtime，写前断言"本会话读过且此后 mtime 未变"，写后用工具自己产出的
// mtime 刷新记录。
// 记录 mtime 而非读取墙钟：外部拷贝/解压产生的"未来 mtime"文件不会永久误报，
// 且能抓到把旧版本原样恢复回去（mtime 倒退）这类墙钟方案漏掉的改动。
//
// 261031 Red 记录落盘：此前纯进程内存态，server 重启后哪怕同一会话刚读过，首次覆写仍要求
// 重读。DeepSeek 官方 harness 与 ZCode 都踩过同一堵墙（ZCode 的 ZCT-202606-B2299F52 里模型
// 反复被 File has not been read yet 挡住），解法是把每个文件最近一次读/写记录带出进程。
// 这里按会话落 data/file-time/<sessionID>.json，冷启动后首次 record/assert 惰性加载；
// 磁盘读失败、损坏、版本不符一律当"没读过"——fail-safe 方向必须是要求重读，不能放行。
// 不落盘的是"读取失败/被跳过"的文件：它们本来就没进内存表，record 也不会被调用。
// 261105 Red 记录格式 v2：除 mtime 外再存内容哈希。mtime 变了但字节相同（git checkout
// 回同一内容、编辑器无改动保存、touch）时直接放行并刷新记录，不再逼模型重读大文件。
// v1 记录无法判断内容，升级后一律当没读过（fail-safe 方向不变）。
const VERSION = 2

// 单会话记录上限。一个会话读过的文件数是路径表量级（几十到几百），上限只挡异常堆积；
// 超出时丢最旧（Map 保插入序），被丢的文件下次覆写会要求重读，与回收语义同向。
const MAX_FILES = 2000

// 超过这个大小的文件不记哈希，退化为纯 mtime 比对：读一次 8MB 只为了比对签名的成本
// 不值得，且这类文件本来也多半不是模型手改的对象。
const MAX_HASH_BYTES = 8 * 1024 * 1024

// 261105 Red 测试钩子：digest 累计读取的字节数，用于断言超限文件不被读入内存。
let bytesHashed = 0

interface Stamp {
  mtime: number
  hash?: string
}

const state = new Map<string, Map<string, Stamp>>()

const log = Log.create({ service: "file.time" })

// 261029 Red 路径可覆盖（测试隔离）：每次取值而非模块加载时定，照 prompt-pin 的模式
const dir = () => process.env["REDCODE_FILE_TIME_DIR"] || path.join(Global.Path.data, "file-time")

const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_")
const file = (sessionID: string) => path.join(dir(), `${sanitize(sessionID)}.json`)

// 已尝试加载过磁盘记录的会话（加载失败也记，避免每次 assert 都读同一个坏文件）
const loaded = new Set<string>()

// 写盘串成一条链：record 只把最新快照排进队列，保持先后顺序
let writeChain: Promise<void> = Promise.resolve()

// 261031 Red 写删竞态：会话在写任务排队后被 evictor 回收时，晚到的写会把刚删掉的文件
// 重新创建出来，下次续接便绕过预期的重读。drop 先把 sessionID 记进来，排队任务执行时
// 据此丢弃已淘汰的写；会话若又被 record（同一 ID 复活）则清掉这个标记。
const dropped = new Set<string>()

// 兜底清理：evictor 只在会话被触碰时回收，进程重启后没人碰的旧会话文件会留一辈子。
// 每个进程只扫一次目录，删掉超过 7 天没更新的记录——冷到一周的会话重启后本来也该重读。
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000
let pruned = false
function pruneOnce() {
  if (pruned) return
  pruned = true
  void fsp
    .readdir(dir())
    .then(async (names) => {
      const cutoff = Date.now() - PRUNE_AGE_MS
      for (const name of names) {
        if (!name.endsWith(".json")) continue
        const target = path.join(dir(), name)
        const stat = await fsp.stat(target).catch(() => undefined)
        if (stat && stat.mtimeMs < cutoff) await fsp.rm(target, { force: true }).catch(() => {})
      }
    })
    .catch(() => {})
}

function persist(sessionID: string) {
  const bucket = state.get(sessionID)
  const payload = JSON.stringify({ version: VERSION, sessionID, files: bucket ? Object.fromEntries(bucket) : {} })
  writeChain = writeChain.then(() => {
    if (dropped.has(sessionID)) return
    return fsp
      .mkdir(dir(), { recursive: true })
      .then(() => fsp.writeFile(file(sessionID), payload))
      // 写失败不影响守卫主路径：最坏重启后要求重读，即本特性部署前的行为
      .catch(() => {})
  })
}

function hydrate(sessionID: string) {
  if (loaded.has(sessionID)) return
  loaded.add(sessionID)
  // 已回收的会话不能从磁盘重新加载：删除排在写队列里，此刻文件可能还在。
  // 放行等于让回收失效（assert 会认为「读过」），方向必须是要求重读。
  if (dropped.has(sessionID)) return
  let raw: string
  try {
    raw = fs.readFileSync(file(sessionID), "utf-8")
  } catch {
    // 新会话没有记录是常态，读失败等同没读过
    return
  }
  try {
    const parsed = JSON.parse(raw) as { version?: number; files?: unknown }
    if (parsed?.version !== VERSION || typeof parsed.files !== "object" || parsed.files === null) return
    const bucket = new Map<string, Stamp>()
    for (const [key, value] of Object.entries(parsed.files)) {
      if (!value || typeof value !== "object") continue
      const record = value as { mtime?: unknown; hash?: unknown }
      if (typeof record.mtime !== "number" || !Number.isFinite(record.mtime)) continue
      bucket.set(
        key,
        typeof record.hash === "string" ? { mtime: record.mtime, hash: record.hash } : { mtime: record.mtime },
      )
    }
    if (bucket.size > 0) state.set(sessionID, bucket)
  } catch {
    // 损坏的记录一律弃用（fail-safe：要求重读），下次 record 会用新内容覆盖它
  }
}

// 260819 cc audit：state 此前零删除——没有任何删除点，也没人订阅 Session.Event.Deleted，
// 会话维度只增不减。CLI 无影响（进程即会话），但 GUI sidecar 与 serve 是长驻多会话进程，
// 每个会话留下一整张「读过的文件 → mtime」表。回收口径与阈值见 util/session-evictor.ts，
// record/assert 都算触碰，活跃会话不会被回收。
//
// 回收一个会话的代价是 fail-safe 的：下次覆写该文件时守卫要求先重读（而不是放行旧内容）。
// 对一个已经一小时没动静的会话来说，这恰恰也是更正确的行为——文件很可能真的变了。
const evictor = sessionEvictor({
  ttlMs: SESSION_TTL_MS,
  max: MAX_SESSIONS,
  drop: (sessionID) => {
    const had = state.delete(sessionID)
    loaded.delete(sessionID)
    dropped.add(sessionID)
    // 删除排进同一条写队列：保证排在已入队的写之后，后续写由 persist 里的 dropped 检查拦下
    writeChain = writeChain.then(() => fsp.rm(file(sessionID), { force: true }).catch(() => {}))
    return had ? 1 : 0
  },
})

function touch(sessionID: string) {
  const evicted = evictor.touch(sessionID)
  if (evicted.length > 0) log.info("evicted", { sessions: evicted.length, live: evictor.size() })
}
function key(filepath: string) {
  return AppFileSystem.resolve(filepath)
}

async function mtime(filepath: string) {
  const stat = await fsp.stat(filepath).catch(() => undefined)
  return stat?.mtimeMs
}

// 261105 Red 内容哈希：mtime 抖动（checkout/无改动保存/touch）不该逼模型重读大文件。
// 261105 Red 验收补洞：assert 侧的比对同样要守住大小上限——record 之后文件被外部换成
// 几百 MiB 的大文件时，直接 readFile 会把整个文件读进内存。超限按「无法比对」处理，
// 走 modified externally 分支（fail-safe 方向与记录阶段一致）。
async function digest(filepath: string) {
  const stat = await fsp.stat(filepath).catch(() => undefined)
  if (!stat || stat.size > MAX_HASH_BYTES) return undefined
  const data = await fsp.readFile(filepath).catch(() => undefined)
  if (!data) return undefined
  bytesHashed += data.length
  return createHash("sha256").update(data).digest("hex").slice(0, 32)
}

// record 用一次 stat + 一次 read 取一致快照，避免 mtime 与内容分两次读之间被改。
async function stamp(filepath: string): Promise<Stamp | undefined> {
  const stat = await fsp.stat(filepath).catch(() => undefined)
  if (!stat) return undefined
  if (stat.size > MAX_HASH_BYTES) return { mtime: stat.mtimeMs }
  const data = await fsp.readFile(filepath).catch(() => undefined)
  if (!data) return { mtime: stat.mtimeMs }
  return { mtime: stat.mtimeMs, hash: createHash("sha256").update(data).digest("hex").slice(0, 32) }
}

export namespace FileTime {
  export const record = Effect.fn("FileTime.record")(function* (sessionID: string, filepath: string) {
    const value = yield* Effect.promise(() => stamp(filepath))
    if (value === undefined) return
    // 先加载再写：否则新建的空表会覆盖磁盘上同会话其它文件的记录
    hydrate(sessionID)
    dropped.delete(sessionID)
    touch(sessionID)
    const bucket = state.get(sessionID) ?? new Map<string, Stamp>()
    bucket.set(key(filepath), value)
    while (bucket.size > MAX_FILES) {
      const oldest = bucket.keys().next()
      if (oldest.done) break
      bucket.delete(oldest.value)
    }
    state.set(sessionID, bucket)
    pruneOnce()
    persist(sessionID)
  })

  export const assert = Effect.fn("FileTime.assert")(function* (sessionID: string, filepath: string) {
    hydrate(sessionID)
    touch(sessionID)
    const recorded = state.get(sessionID)?.get(key(filepath))
    if (recorded === undefined) {
      return yield* Effect.fail(new Error(`You must read file ${filepath} with the read tool before overwriting it.`))
    }

    const current = yield* Effect.promise(() => mtime(filepath))
    // 文件在读后被删掉的情况交给调用方的 exists/stat 检查表达语义，这里不重复报错。
    if (current === undefined) return
    if (current === recorded.mtime) return

    // 261105 Red mtime 变了、内容没变：git checkout 回同一内容、编辑器无改动保存、touch。
    // 放行并刷新记录，不再逼模型重读大文件；真并发冲突哈希不同仍会被拦。
    if (recorded.hash) {
      const now = yield* Effect.promise(() => digest(filepath))
      if (now !== undefined && now === recorded.hash) {
        state.get(sessionID)?.set(key(filepath), { mtime: current, hash: now })
        persist(sessionID)
        return
      }
    }

    return yield* Effect.fail(
      new Error(
        `File ${filepath} has been modified externally since it was last read ` +
          `(read at mtime ${new Date(recorded.mtime).toISOString()}, now ${new Date(current).toISOString()}). ` +
          `Read the file again before writing to it. If you only need to change part of it, ` +
          `an oldString replacement skips the full-file re-read.`,
      ),
    )
  })

  /** 测试钩子：digest 累计读取的字节数（断言超限大文件不被读入内存） */
  export const hashBytesRead = () => bytesHashed

  /** 测试钩子：当前驻留的会话数（同 edit.ts 的 fileLockCount，只给测试断言回收用） */
  export const sessionCount = () => state.size

  /** 测试钩子：排空写盘队列（record 的落盘是异步 fire-and-forget） */
  export const flush = () => writeChain

  /** 测试钩子：模拟进程重启——只清内存，磁盘记录保留，用于验证冷启动恢复 */
  export const reload = () => {
    state.clear()
    loaded.clear()
    evictor.clear()
    dropped.clear()
  }

  /** 测试钩子：清空进程内记录，避免用例之间互相污染（与 reload 同实现，磁盘由测试目录清理） */
  export const reset = reload
}
