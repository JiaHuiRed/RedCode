type AttachmentSize = { size?: number; dataUrl: string }

// 260913 Red 附件共用体积/数量预算：在读取内容和生成落盘文件**之前**检查，
// 避免先把 10MB+ 的文件整份读进内存、写完盘再拒绝。
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_PROMPT_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_PROMPT_ATTACHMENTS = 8

// dataUrl 的 base64 负载换算成原始字节。畸形 dataUrl（没有逗号）按整体长度算：
// 高估只会多拒一个附件，低估会把上限撑破。
export function attachmentBytes(part: AttachmentSize) {
  if (part.size !== undefined) return part.size
  const comma = part.dataUrl.indexOf(",")
  const payload = comma < 0 ? part.dataUrl.length : part.dataUrl.length - comma - 1
  return Math.ceil((payload * 3) / 4)
}

export function attachmentFits(
  size: number,
  parts: readonly AttachmentSize[],
  pending: { bytes: number; count: number },
) {
  return (
    size <= MAX_ATTACHMENT_BYTES &&
    parts.length + pending.count < MAX_PROMPT_ATTACHMENTS &&
    parts.reduce((total, part) => total + attachmentBytes(part), pending.bytes + size) <= MAX_PROMPT_ATTACHMENT_BYTES
  )
}
