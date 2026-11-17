import { Locale } from "@/util/locale"

// 261116 Red 后台活动面板的展示判定与文案，抽成纯函数供组件与定向测试共用。
// OpenAPI 的数字字段允许 JSON 的非有限值字符串，展示前统一用 Number() 收口。
export type Num = number | "Infinity" | "-Infinity" | "NaN"

export type BackgroundJob = {
  id: string
  type: string
  title?: string
  status: "running" | "completed" | "error" | "cancelled"
  startedAt: Num
  completedAt?: Num
  error?: string
  sessionID?: string
  parentSessionID?: string
}

export type BackgroundPty = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited" | "orphaned"
  pid: number
}

export const JOB_STATUS: Record<BackgroundJob["status"], string> = {
  running: "运行中",
  completed: "已完成",
  error: "失败",
  cancelled: "已取消",
}

export const PTY_STATUS: Record<BackgroundPty["status"], string> = {
  running: "运行中",
  exited: "已退出",
  orphaned: "上次未正常结束",
}

export type JobOpenTarget = { kind: "session"; sessionID: string } | { kind: "missing" }

// 261116 Red A01：只认服务端登记的 sessionID。job id 与 session id 是两套命名空间，
// 结果已回收 / 旧记录缺会话时明确说明，绝不拿 job id 去猜一个会话。
export function jobOpenTarget(job: Pick<BackgroundJob, "sessionID">): JobOpenTarget {
  if (!job.sessionID) return { kind: "missing" }
  return { kind: "session", sessionID: job.sessionID }
}

export function jobDetail(job: BackgroundJob, now: number) {
  const elapsed = Locale.duration(Number(job.completedAt ?? now) - Number(job.startedAt))
  const base = `${job.type} · ${JOB_STATUS[job.status]} · ${elapsed}`
  const session = job.sessionID ? "" : " · 无关联会话（无法直接打开）"
  return job.error ? `${base}${session} · ${job.error}` : base + session
}

export function ptyDetail(pty: BackgroundPty) {
  return `PID ${pty.pid} · ${PTY_STATUS[pty.status]} · ${pty.cwd}`
}

// 真实启动命令 + 参数，原样展示；启动的是 shell 就按 shell 展示，不推测它内部的当前命令。
export function ptyCommandLine(pty: Pick<BackgroundPty, "command" | "args">) {
  return [pty.command, ...pty.args].join(" ")
}

export function ptyStatusNote(status: BackgroundPty["status"]) {
  switch (status) {
    case "running":
      return "运行中：这里只读查看已有输出，不会向进程发送输入。"
    case "exited":
      return "已退出：进程已结束，可能不再有输出。"
    case "orphaned":
      return "上次未正常结束：进程实际状态未知，重启后不保留输出缓冲。"
  }
}

// 现有 PTY 登记没有来源会话/用途字段；旧记录或来源缺失就如实写「未知」，不反推假归属。
export function ptySourceNote(source?: { sessionID?: string; title?: string }) {
  if (!source?.sessionID) return "来源：未知（该终端创建时没有记录来源会话，不按 PID 反推归属）"
  return `来源：${source.title ?? "终端"}（会话 ${source.sessionID}）`
}

export const PTY_DISPLAY_LIMIT = 20_000

export function ptyOutputNotice(input: {
  truncated: boolean
  shownChars: number
  startCursor?: number
  endCursor?: number
}) {
  const range =
    input.startCursor !== undefined && input.endCursor !== undefined
      ? `（游标 ${input.startCursor}–${input.endCursor}）`
      : ""
  if (!input.truncated) return `输出 ${input.shownChars.toLocaleString()} 字符${range}`
  return `输出已截断：只显示最近 ${input.shownChars.toLocaleString()} 字符${range}`
}
