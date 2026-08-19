import * as fsp from "fs/promises"
import { Effect } from "effect"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import * as Log from "@redcode-ai/core/util/log"
import { MAX_SESSIONS, SESSION_TTL_MS, sessionEvictor } from "@/util/session-evictor"

// 260810 cc audit R2: "写前已读"守卫（上游 FileTime 的移植，比对口径从墙钟改为 mtime）。
// write/edit 此前不校验文件是否被本会话 read 过、也不比对改动时间——IDE 手改、git 操作、
// 并行 subagent 落盘的内容会被 agent 拿着旧文整个推平。这里按 (sessionID, 绝对路径) 记录
// read 时刻的文件 mtime，写前断言"本会话读过且此后 mtime 未变"，写后用工具自己产出的
// mtime 刷新记录。纯进程内存态：server 重启后首次覆写会要求先重读，这是期望行为。
// 记录 mtime 而非读取墙钟：外部拷贝/解压产生的"未来 mtime"文件不会永久误报，
// 且能抓到把旧版本原样恢复回去（mtime 倒退）这类墙钟方案漏掉的改动。
const state = new Map<string, Map<string, number>>()

const log = Log.create({ service: "file.time" })

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
  drop: (sessionID) => (state.delete(sessionID) ? 1 : 0),
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

export namespace FileTime {
  export const record = Effect.fn("FileTime.record")(function* (sessionID: string, filepath: string) {
    const value = yield* Effect.promise(() => mtime(filepath))
    if (value === undefined) return
    touch(sessionID)
    const bucket = state.get(sessionID) ?? new Map<string, number>()
    bucket.set(key(filepath), value)
    state.set(sessionID, bucket)
  })

  export const assert = Effect.fn("FileTime.assert")(function* (sessionID: string, filepath: string) {
    touch(sessionID)
    const recorded = state.get(sessionID)?.get(key(filepath))
    if (recorded === undefined) {
      return yield* Effect.fail(new Error(`You must read file ${filepath} with the read tool before overwriting it.`))
    }

    const current = yield* Effect.promise(() => mtime(filepath))
    // 文件在读后被删掉的情况交给调用方的 exists/stat 检查表达语义，这里不重复报错。
    if (current === undefined) return

    if (current !== recorded) {
      return yield* Effect.fail(
        new Error(
          `File ${filepath} has been modified externally since it was last read ` +
            `(read at mtime ${new Date(recorded).toISOString()}, now ${new Date(current).toISOString()}). ` +
            `Read the file again before writing to it.`,
        ),
      )
    }
  })

  /** 测试钩子：当前驻留的会话数（同 edit.ts 的 fileLockCount，只给测试断言回收用） */
  export const sessionCount = () => state.size

  /** 测试钩子：清空进程内记录，避免用例之间互相污染 */
  export const reset = () => {
    state.clear()
    evictor.clear()
  }
}
