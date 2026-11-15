import type { Part as PartType, ToolPart } from "@redcode-ai/sdk/v2"

// 261115 Red A-UX-03：工具按「探索 / 修改 / 命令」三类分段折叠。分段与组键是纯函数，
// 拆在独立模块里（message-part.tsx 依赖 @solidjs/router，测试环境加载不了）。
const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
const EDIT_GROUP_TOOLS = new Set(["edit", "write", "apply_patch"])
const COMMAND_GROUP_TOOLS = new Set(["shell", "bash"])

export type ToolGroupKind = "context" | "edit" | "command"

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: ToolGroupKind
      refs: PartRef[]
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type === "part") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

export function toolGroupKind(part: PartType): ToolGroupKind | undefined {
  if (part.type !== "tool") return
  if (CONTEXT_GROUP_TOOLS.has(part.tool)) return "context"
  if (EDIT_GROUP_TOOLS.has(part.tool)) return "edit"
  if (COMMAND_GROUP_TOOLS.has(part.tool)) return "command"
  return
}

export function isGroupedTool(part: PartType): part is ToolPart {
  return toolGroupKind(part) !== undefined
}

export function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  let start = -1
  let kind: ToolGroupKind | undefined

  const flush = (end: number) => {
    if (start < 0 || !kind) return
    const first = parts[start]
    if (!first) {
      start = -1
      kind = undefined
      return
    }
    result.push({
      key: `${kind}:${first.part.id}`,
      type: kind,
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
    })
    start = -1
    kind = undefined
  }

  parts.forEach((item, index) => {
    const next = toolGroupKind(item.part)
    if (next) {
      // 连续同类才合并；探索 → 修改 → 命令各成一段，不混进一个摘要。
      if (kind && kind !== next) flush(index - 1)
      if (start < 0) {
        start = index
        kind = next
      }
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}
