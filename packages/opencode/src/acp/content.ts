// 261006 Red 从 agent.ts 单体拆出（上游 acp/content.ts 的对应物）：完成的 ToolPart
// → ACP ToolCallContent 的转换（文本 + edit diff + 图片附件），纯函数。

import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk"
import type { ToolPart } from "@redcode-ai/sdk/v2"

export function completedToolContent(part: ToolPart, kind: ToolKind): ToolCallContent[] {
  if (part.state.status !== "completed") return []

  const content: ToolCallContent[] = [
    {
      type: "content",
      content: {
        type: "text",
        text: part.state.output,
      },
    },
  ]

  if (kind === "edit") {
    const input = part.state.input
    const filePath = typeof input["filePath"] === "string" ? input["filePath"] : ""
    const oldText = typeof input["oldString"] === "string" ? input["oldString"] : ""
    const newText =
      typeof input["newString"] === "string"
        ? input["newString"]
        : typeof input["content"] === "string"
          ? input["content"]
          : ""
    content.push({
      type: "diff",
      path: filePath,
      oldText,
      newText,
    })
  }

  content.push(...imageContents(part.state.attachments ?? []))
  return content
}

export function completedToolRawOutput(part: ToolPart) {
  if (part.state.status !== "completed") return {}
  return {
    output: part.state.output,
    metadata: part.state.metadata,
    ...(part.state.attachments?.length ? { attachments: part.state.attachments } : {}),
  }
}

export function imageContents(attachments: Array<{ mime: string; url: string }>): ToolCallContent[] {
  return attachments.flatMap((attachment): ToolCallContent[] => {
    const match = attachment.url.match(/^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/)
    const mime = match?.[1] ?? attachment.mime
    if (!mime.startsWith("image/")) return []
    const data = match?.[2]
    if (data === undefined) return []
    return [
      {
        type: "content" as const,
        content: {
          type: "image" as const,
          mimeType: mime,
          data,
        },
      },
    ]
  })
}

export * as Content from "./content"
