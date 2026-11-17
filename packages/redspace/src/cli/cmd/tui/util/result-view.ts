import type { Part } from "@redcode-ai/sdk/v2"

// 261116 Red A06：按轮结果阅读只是展示组织，不改模型上下文、不删持久记录。
// 只折叠「正常完成」的过程；运行中、失败、待权限/待回答一律保持原样。
export type ResultRow = { kind: "part"; part: Part } | { kind: "process"; tools: number; reasoning: number }

export function canCollapseProcess(input: { completed?: number; error?: unknown }, parts: Part[]) {
  if (input.completed === undefined || input.error !== undefined) return false
  const process = parts.filter((part) => part.type === "tool" || part.type === "reasoning")
  if (process.length === 0) return false
  return process.every((part) => part.type !== "tool" || part.state.status === "completed")
}

export function collapseProcessRows(parts: Part[]): ResultRow[] {
  const rows: ResultRow[] = []
  let tools = 0
  let reasoning = 0
  const flush = () => {
    if (tools + reasoning === 0) return
    rows.push({ kind: "process", tools, reasoning })
    tools = 0
    reasoning = 0
  }
  for (const part of parts) {
    if (part.type === "tool") {
      tools += 1
      continue
    }
    if (part.type === "reasoning") {
      reasoning += 1
      continue
    }
    flush()
    rows.push({ kind: "part", part })
  }
  flush()
  return rows
}

export function processSummary(input: { tools: number; reasoning: number; expanded: boolean }) {
  const detail =
    [
      input.tools > 0 ? `${input.tools} 个工具` : undefined,
      input.reasoning > 0 ? `${input.reasoning} 段思考` : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || "0 项"
  return input.expanded ? `收起过程（${detail}，保留结果）` : `已折叠过程：${detail}（点击展开原始执行）`
}
