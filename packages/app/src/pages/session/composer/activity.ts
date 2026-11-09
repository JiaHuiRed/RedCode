// 261109 Karina UX-02：Agent 活动状态的纯推导层。
//
// 只读「已经到达客户端的事实」：工具 part 的 tool/state、子会话状态、待批准权限。
// 不猜百分比、不猜模型在想什么；缓存可能被截断（global-sync/types.ts），所以计数
// 语义是「已加载范围内」，展示时不能冒充整轮总数。
export type ActivityPart = {
  type: string
  tool?: string
  state?: {
    status?: "pending" | "running" | "completed" | "error" | string
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
    // 失败单独计，绝不计入「读了多少/改了多少」——失败的 read 没有产出内容。
    if (status === "error") {
      counts.failed += 1
      continue
    }
    if (status !== "completed") {
      // pending 的入参可能还没齐；running 才是可信的「正在做」。
      if (status === "running") running = { tool: part.tool, target: targetOf(part.state?.input) }
      continue
    }
    if (part.tool === "read") counts.read += 1
    else if (EDIT_TOOLS.has(part.tool)) counts.edit += 1
    else if (COMMAND_TOOLS.has(part.tool)) counts.command += 1
  }

  return { running, counts }
}
