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

// 261018 Red 在途额度**按会话合成一条**：字节仍分内联/压缩包两类记账，件数只有一个
// 共享计数器。原先按类别各存一份 { bytes, count }，件数也因此按类别隔离——同时进来
// 一张图和一包 ZIP 时，各自只看见本类别的在途件数，能一起突破 8 件上限。
export type PendingBudget = { inlineBytes: number; archiveBytes: number; count: number }

// dataUrl 的 base64 负载换算成原始字节。畸形 dataUrl（没有逗号）按整体长度算：
// 高估只会多拒一个附件，低估会把上限撑破。
export function attachmentBytes(part: AttachmentSize) {
  if (part.size !== undefined) return part.size
  const comma = part.dataUrl.indexOf(",")
  const payload = comma < 0 ? part.dataUrl.length : part.dataUrl.length - comma - 1
  return Math.ceil((payload * 3) / 4)
}

// 261018 Red 现有附件按类别分组：`count` 永远算全部（含压缩包），`inline`/`archives`
// 只决定各自参与哪条字节线。分组放在这里而不是调用方，是为了让「顺序无关」这条不变量
// 能被单测直接覆盖——分组逻辑一旦被测试复刻，复刻就会漂移。
export function presentBudget<T extends AttachmentSize>(
  existing: readonly T[],
  isArchive: (part: T) => boolean,
) {
  return {
    count: existing.length,
    inline: existing.filter((part) => !isArchive(part)),
    archives: existing.filter(isArchive),
  }
}

// `inline` 只收内联附件（图片/PDF），压缩包不参与这组字节求和；`count` 是全部附件
// （含压缩包）的件数——数量上限仍然共享，不允许「各类别各 8 个」。
export function attachmentFits(
  size: number,
  inline: readonly AttachmentSize[],
  count: number,
  pending: PendingBudget,
) {
  return (
    size <= MAX_ATTACHMENT_BYTES &&
    count + pending.count < MAX_PROMPT_ATTACHMENTS &&
    inline.reduce((total, part) => total + attachmentBytes(part), pending.inlineBytes + size) <=
      MAX_PROMPT_ATTACHMENT_BYTES
  )
}

// 压缩包与图片/PDF 分开记账：同一条消息里可以既有大图又有大包，两者的字节来源不同
// （base64 常驻 vs 一次性落盘），共用一条总量线会互相挤掉。
export function archiveFits(
  size: number,
  archives: readonly AttachmentSize[],
  count: number,
  pending: PendingBudget,
) {
  return (
    size <= MAX_ARCHIVE_BYTES &&
    count + pending.count < MAX_PROMPT_ATTACHMENTS &&
    archives.reduce((total, part) => total + attachmentBytes(part), pending.archiveBytes + size) <=
      MAX_PROMPT_ARCHIVE_BYTES
  )
}
