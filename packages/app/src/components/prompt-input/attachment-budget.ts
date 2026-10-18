type AttachmentSize = { size?: number; dataUrl: string }

// 260913 Red 附件共用体积/数量预算：在读取内容和生成落盘文件**之前**检查，
// 避免先把 10MB+ 的文件整份读进内存、写完盘再拒绝。
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_PROMPT_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_PROMPT_ATTACHMENTS = 8

// 261018 Red 压缩包走独立预算：它只落盘、绝不作 base64 内联（见 files.ts 与
// provider/transform 的路径占位），10/20 MiB 那组上限是为 base64 常驻设的，套在压缩包上
// 会把 36 MiB 的调试包这类正常用途一并拒掉。落盘前仍要整包读进 renderer 一次（arrayBuffer），
// 所以上限按「一次性内存 + IPC 复制」定在 64 MiB，而不是无界。
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_PROMPT_ARCHIVE_BYTES = 128 * 1024 * 1024

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

// 压缩包与图片/PDF 分开记账：同一条消息里可以既有大图又有大包，两者的字节来源不同
// （base64 常驻 vs 一次性落盘），共用一条总量线会互相挤掉。数量上限仍共享——
// `parts` 传全部附件，`archives` 只传其中的压缩包。
export function archiveFits(
  size: number,
  parts: readonly AttachmentSize[],
  archives: readonly AttachmentSize[],
  pending: { bytes: number; count: number },
) {
  return (
    size <= MAX_ARCHIVE_BYTES &&
    parts.length + pending.count < MAX_PROMPT_ATTACHMENTS &&
    archives.reduce((total, part) => total + attachmentBytes(part), pending.bytes + size) <= MAX_PROMPT_ARCHIVE_BYTES
  )
}
