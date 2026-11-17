// 261109 Karina UX-02：TUI 活动状态推导（与 GUI 的 composer/activity.ts 同口径）。
//
// 只读已到达客户端的事实：工具 part 的 tool/state。没有百分比、没有推测阶段；
// 计数是「已加载消息范围内」的数量，失败单列，绝不混进成功计数。
// 261110 Red target 带 kind、值保留完整：命令不做 basename、不在数据层截断；
// TUI 没有 CSS truncate，展示层用 targetText 定长截断并显式加省略号。
export type ActivityTarget =
  | { kind: "file"; value: string }
  | { kind: "command"; value: string }
  | { kind: "pattern"; value: string }

export type ActivityPart = {
  type: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    time?: { start?: number; end?: number }
  }
}

export type Activity = {
  running?: { tool: string; target?: ActivityTarget; started?: number }
  counts: { read: number; edit: number; command: number; failed: number }
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"])
const COMMAND_TOOLS = new Set(["bash", "shell", "pty"])

const targetOf = (input: Record<string, unknown> | undefined): ActivityTarget | undefined => {
  if (!input) return undefined
  if (typeof input.filePath === "string") return { kind: "file", value: input.filePath }
  if (typeof input.path === "string") return { kind: "file", value: input.path }
  if (typeof input.command === "string") return { kind: "command", value: input.command }
  if (typeof input.pattern === "string") return { kind: "pattern", value: input.pattern }
  return undefined
}

export function deriveActivity(parts: readonly ActivityPart[]): Activity {
  const counts = { read: 0, edit: 0, command: 0, failed: 0 }
  let running: Activity["running"]

  for (const part of parts) {
    if (part.type !== "tool" || !part.tool) continue
    const status = part.state?.status
    if (status === "error") {
      counts.failed += 1
      continue
    }
    if (status !== "completed") {
      if (status === "running")
        running = {
          tool: part.tool,
          target: targetOf(part.state?.input),
          started: typeof part.state?.time?.start === "number" ? part.state.time.start : undefined,
        }
      continue
    }
    if (part.tool === "read") counts.read += 1
    else if (EDIT_TOOLS.has(part.tool)) counts.edit += 1
    else if (COMMAND_TOOLS.has(part.tool)) counts.command += 1
  }

  return { running, counts }
}

const basename = (value: string) => {
  const normalized = value.replaceAll("\\", "/")
  const index = normalized.lastIndexOf("/")
  return index === -1 ? normalized : normalized.slice(index + 1)
}

// TUI 展示层：无 CSS truncate，这里定长截断并显式加省略号。
// file 取 basename；命令保留命令头绝不路径化；超长的命令/模式尾部加 …。
export function targetText(target: ActivityTarget, max = 48) {
  const text =
    target.kind === "file" ? basename(target.value) : target.value.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}
