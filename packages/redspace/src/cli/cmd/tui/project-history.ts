// 261110 Red TUI 最近项目记录。启动时用它决定是否恢复上次目录，导航成功后追加一条；
// 只存最近元数据（目录、名称、上次会话、时间），不存草稿或任何运行状态。
import path from "path"
import { Global } from "@redcode-ai/core/global"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Flock } from "@redcode-ai/core/util/flock"
import * as Log from "@redcode-ai/core/util/log"
import { isRecord } from "@/util/record"
import { Filesystem } from "@/util/filesystem"

export interface ProjectVisit {
  directory: string
  name?: string
  sessionID?: string
  usedAt: number
}

const log = Log.create({ service: "tui.project-history" })

// 261110 Red 路径必须在调用时求值：测试会覆写 Global.Path.state，导入时固化就拿不到隔离目录。
function file() {
  return path.join(Global.Path.state, "projects.json")
}

function lockKey() {
  return `tui-project-history:${file()}`
}

// 261110 Red Windows 上同一目录有大小写/斜杠差异，去重按规范路径比较（与 project-selector 同口径）。
function normalize(directory: string) {
  const resolved = path.resolve(directory).replaceAll("\\", "/").replace(/\/+$/, "")
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function visit(value: unknown): ProjectVisit[] {
  if (!isRecord(value)) return []
  if (typeof value.directory !== "string" || !value.directory.trim()) return []
  if (typeof value.usedAt !== "number" || !Number.isFinite(value.usedAt)) return []
  return [
    {
      directory: value.directory,
      ...(typeof value.name === "string" && value.name ? { name: value.name } : {}),
      ...(typeof value.sessionID === "string" && value.sessionID ? { sessionID: value.sessionID } : {}),
      usedAt: value.usedAt,
    },
  ]
}

function dedupe(list: ProjectVisit[]) {
  const seen = new Map<string, ProjectVisit>()
  for (const item of list) {
    const key = normalize(item.directory)
    const prev = seen.get(key)
    if (!prev || prev.usedAt <= item.usedAt) seen.set(key, item)
  }
  return [...seen.values()].sort((a, b) => b.usedAt - a.usedAt)
}

function parse(text: string) {
  try {
    const data: unknown = JSON.parse(text)
    // 261110 Red 兼容旧版「纯数组」历史文件；新格式带上 ignored，供工作区管理里删除用。
    if (Array.isArray(data)) return { visits: dedupe(data.flatMap(visit)), ignored: [] as string[] }
    if (!isRecord(data)) return { visits: [], ignored: [] as string[] }
    const visits = Array.isArray(data.visits) ? dedupe(data.visits.flatMap(visit)) : []
    const ignored = Array.isArray(data.ignored)
      ? data.ignored.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : []
    return { visits, ignored }
  } catch (error) {
    // 261110 Red 历史文件损坏只丢「恢复最近目录」能力，不能让启动失败
    log.warn("invalid project history", { path: file(), error })
    return { visits: [], ignored: [] as string[] }
  }
}

async function readUnlocked(): Promise<{ visits: ProjectVisit[]; ignored: string[] }> {
  const text = await Filesystem.readText(file()).catch((error) => {
    // 261110 Red 首次运行没有历史文件是正常状态；其他读失败同样只影响恢复能力
    if ((error as { code?: string }).code !== "ENOENT")
      log.warn("failed to read project history", { path: file(), error })
    return undefined
  })
  if (!text) return { visits: [], ignored: [] }
  return parse(text)
}

async function writeUnlocked(value: { visits: ProjectVisit[]; ignored: string[] }) {
  await AppFileSystem.writeFileAtomic(file(), JSON.stringify(value, null, 2))
}

export async function readProjectHistory(): Promise<ProjectVisit[]> {
  return Flock.withLock(lockKey(), () => readUnlocked().then((value) => value.visits)).catch((error) => {
    // 261110 Red 跨进程锁失败也只丢「恢复最近目录」，不能挡住 TUI 启动
    log.warn("failed to lock project history", { path: file(), error })
    return []
  })
}

export async function recordProjectVisit(entry: {
  directory: string
  name?: string
  sessionID?: string
}): Promise<void> {
  if (!entry.directory.trim()) return
  await Flock.withLock(lockKey(), async () => {
    // 261110 Red 读-改-写必须在同一把锁内，多个 TUI 同时记录才不会互相覆盖
    const value = await readUnlocked()
    const key = normalize(entry.directory)
    // 261110 Red 启动记录与回首页的访问都不带 sessionID：直接替换会抹掉「最后查看会话」。
    // 没提供新值就继承旧记录，只有真正切到另一段会话时才更新。
    const previous = value.visits.find((item) => normalize(item.directory) === key)
    const sessionID = entry.sessionID ?? previous?.sessionID
    const next: ProjectVisit = {
      directory: entry.directory,
      ...(entry.name ? { name: entry.name } : {}),
      ...(sessionID ? { sessionID } : {}),
      usedAt: Date.now(),
    }
    const merged = [next, ...value.visits.filter((item) => normalize(item.directory) !== key)].sort(
      (a, b) => b.usedAt - a.usedAt,
    )
    // 重新访问即撤销「已删除」标记，否则切过去还会被当成隐藏项。
    await writeUnlocked({ visits: merged, ignored: value.ignored.filter((item) => normalize(item) !== key) })
  })
}

// 261110 Red 工作区管理里的「删除」只把目录移进 ignored：不动目录、不动服务端会话与项目行。
// 返回是否真的存在并移除；文件不存在时按未命中处理。
export async function forgetProjectVisit(directory: string): Promise<boolean> {
  if (!directory.trim()) return false
  return Flock.withLock(lockKey(), async () => {
    const value = await readUnlocked()
    const key = normalize(directory)
    const kept = value.visits.filter((item) => normalize(item.directory) !== key)
    const removed = kept.length !== value.visits.length
    if (!removed && value.ignored.some((item) => normalize(item) === key)) return false
    await writeUnlocked({
      visits: kept,
      ignored: [...value.ignored.filter((item) => normalize(item) !== key), directory],
    })
    return true
  })
}

// 261110 Red 列表要过滤「已删除」的工作区；项目表里仍有同名行，不能只删 visits。
export async function readIgnoredProjects(): Promise<string[]> {
  return Flock.withLock(lockKey(), () => readUnlocked().then((value) => value.ignored)).catch((error) => {
    log.warn("failed to lock project history", { path: file(), error })
    return []
  })
}

export * as ProjectHistory from "./project-history"
