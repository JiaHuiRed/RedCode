import path from "path"
import { Cause, Context, Effect } from "effect"
import { readFile } from "node:fs/promises"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Global } from "@redcode-ai/core/global"
import type { Info, Status } from "./job"

// 261104 Red 后台任务落盘：进程重启后还能看见「上次跑过什么」。
// 只存定位与状态，不存 output（子代理全文可达数 MB）。目录走 Context.Reference，
// 测试可用 Layer.succeed 指到临时目录。
export const directory = Context.Reference<string>("redcode/BackgroundJob.directory", {
  defaultValue: () => path.join(Global.Path.data, "background"),
})

export type Entry = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  error?: string
  metadata?: Record<string, unknown>
}

export type Snapshot = {
  version: number
  saved_at: number
  records: Entry[]
}

const VERSION = 1
// 与内存侧 prune 同口径：完成态至多 50 条。运行中的任务不进这个上限——它们要靠落盘
// 在重启后提示「上次未正常结束」，按时间全量截断会把跑得最久、启动最早的任务挤掉。
const KEEP = 50
const queues = new Map<string, Promise<void>>()

function serialized(target: string, task: () => Promise<void>) {
  const previous = queues.get(target) ?? Promise.resolve()
  const next = previous.then(task, task)
  queues.set(
    target,
    next.catch(() => undefined),
  )
  return next
}

// 261105 Red namespace 隔离快照文件：PTY 终端复用同一套落盘但单列一份
// （<hash>.pty.json），两个服务各自整写自己的文件，互不覆盖。
function file(target: string, workspace: string, namespace?: string) {
  const name = Bun.hash(workspace).toString(36)
  return path.join(target, namespace ? `${name}.${namespace}.json` : `${name}.json`)
}

export const read = (target: string, workspace: string, namespace?: string) =>
  Effect.promise(async (): Promise<Snapshot | undefined> => {
    const destination = file(target, workspace, namespace)
    const text = await readFile(destination, "utf8").catch((error: unknown) => {
      // 状态文件只影响重启后的可见性：读不到就当没有，但权限/磁盘问题要留痕。
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
        console.warn(`background job state read failed: ${destination}: ${String(error)}`)
      return undefined
    })
    if (!text) return undefined
    try {
      const parsed = JSON.parse(text) as { version?: number; saved_at?: number; records?: Entry[] } | undefined
      if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.records)) return undefined
      return { version: VERSION, saved_at: Number(parsed.saved_at) || 0, records: parsed.records as Entry[] }
    } catch (error) {
      // 手改、旧版本遗留或磁盘损坏都可能产生非法 JSON。一份坏文件不该阻断该工作区的
      // 后台服务初始化；下一次写盘会用原子替换覆盖它。
      console.warn(`background job state parse failed: ${destination}: ${String(error)}`)
      return undefined
    }
  })

export const write = (target: string, workspace: string, records: Info[], namespace?: string) =>
  Effect.promise(async () => {
    const destination = file(target, workspace, namespace)
    const running = records.filter((record) => record.status === "running")
    const finished = records
      .filter((record) => record.status !== "running")
      .sort((a, b) => a.started_at - b.started_at)
      .slice(-KEEP)
    const snapshot: Snapshot = {
      version: VERSION,
      saved_at: Date.now(),
      records: [...running, ...finished].sort((a, b) => a.started_at - b.started_at).map(toRecord),
    }
    // 同目录 temp + rename 走核心工具：它带 Windows 上 EACCES/EBUSY/EPERM 的重试。
    await serialized(destination, () => AppFileSystem.writeFileAtomic(destination, JSON.stringify(snapshot)))
  }).pipe(
    // 写盘失败只影响「重启后可见性」，不该让任务本身失败；留一条日志便于排查。
    // 文件 I/O 的异常会变成 defect（Effect.promise 的错误通道是 never），所以按 cause 收。
    Effect.catchCause((cause) =>
      Effect.sync(() => console.warn(`background job state write failed: ${Cause.pretty(cause)}`)),
    ),
  )

function toRecord(info: Info): Entry {
  return {
    id: info.id,
    type: info.type,
    title: info.title,
    status: info.status,
    started_at: info.started_at,
    ...(info.completed_at !== undefined ? { completed_at: info.completed_at } : {}),
    ...(info.error !== undefined ? { error: info.error } : {}),
    ...(info.metadata ? { metadata: info.metadata } : {}),
  }
}

// 上次退出时还在 running 的任务不可能真的还在跑（fiber 随进程消失），保留 running 会让
// 面板显示假象、取消也打不到人。改成 error 并写明原因；完成时间取最后一次落盘时间。
export function hydrate(snapshot: Snapshot | undefined): Info[] {
  if (!snapshot) return []
  return snapshot.records.map((record) => {
    if (record.status !== "running") return { ...record }
    return {
      ...record,
      status: "error" as const,
      completed_at: snapshot.saved_at || record.started_at,
      error: "上次运行未正常结束：进程退出时任务仍在运行",
    }
  })
}

export * as BackgroundStore from "./store"
