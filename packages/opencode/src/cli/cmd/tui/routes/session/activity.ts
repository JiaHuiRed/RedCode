// 261109 Karina UX-02：TUI 活动状态推导（与 GUI 的 composer/activity.ts 同口径）。
//
// 只读已到达客户端的事实：工具 part 的 tool/state。没有百分比、没有推测阶段；
// 计数是「已加载消息范围内」的数量，失败单列，绝不混进成功计数。
export type ActivityPart = {
  type: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
  }
}

export type Activity = {
  running?: { tool: string; target?: string }
  counts: { read: number; edit: number; command: number; failed: number }
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"])
const COMMAND_TOOLS = new Set(["bash", "shell", "pty"])

const targetOf = (input: Record<string, unknown> | undefined) => {
  if (!input) return undefined
  if (typeof input.filePath === "string") return input.filePath
  if (typeof input.path === "string") return input.path
  if (typeof input.command === "string") return input.command.slice(0, 48)
  if (typeof input.pattern === "string") return input.pattern.slice(0, 48)
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
      if (status === "running") running = { tool: part.tool, target: targetOf(part.state?.input) }
      continue
    }
    if (part.tool === "read") counts.read += 1
    else if (EDIT_TOOLS.has(part.tool)) counts.edit += 1
    else if (COMMAND_TOOLS.has(part.tool)) counts.command += 1
  }

  return { running, counts }
}

export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}
