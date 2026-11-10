// 261109 Karina UX-02：Agent 活动状态的纯推导层。
//
// 只读「已经到达客户端的事实」：工具 part 的 tool/state、子会话状态、待批准权限。
// 不猜百分比、不猜模型在想什么；缓存可能被截断（global-sync/types.ts），所以计数
// 语义是「已加载范围内」，展示时不能冒充整轮总数。
// 261110 Red 数据层不再截断、不再预判形状：target 带 kind（file/command/pattern），
// 值保留完整，路径化显示（basename）只在展示层对 file 做——命令截 48 再当路径取
// basename，会把 `bun test ./src/session.test.ts` 显示成 `session.test.ts`。
export type ActivityTarget =
  | { kind: "file"; value: string }
  | { kind: "command"; value: string }
  | { kind: "pattern"; value: string }

export type ActivityPart = {
  type: string
  tool?: string
  state?: {
    status?: "pending" | "running" | "completed" | "error" | string
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
    // 失败单独计，绝不计入「读了多少/改了多少」——失败的 read 没有产出内容。
    if (status === "error") {
      counts.failed += 1
      continue
    }
    if (status !== "completed") {
      // pending 的入参可能还没齐；running 才是可信的「正在做」。
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

// 展示层的单行折叠：命令/模式可能多行，压成单行再交给 CSS truncate（省略号）。
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim()

// 显示文本：只有 file 做 basename；命令保留命令头，绝不路径化。
export function targetLabel(target: ActivityTarget) {
  if (target.kind === "command" || target.kind === "pattern") return oneLine(target.value)
  const normalized = target.value.replaceAll("\\", "/")
  const index = normalized.lastIndexOf("/")
  return index === -1 ? normalized : normalized.slice(index + 1)
}

// 悬停完整文本：file 给完整路径，其余与显示文本一致（已是完整内容）。
export function targetTitle(target: ActivityTarget) {
  return target.kind === "file" ? target.value : targetLabel(target)
}
