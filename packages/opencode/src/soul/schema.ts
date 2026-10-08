// 261007 Red Soul System V2：Soul 元数据与摘要类型。
// Soul 是助手身份的唯一事实源（设计 §2.1）；客户端类型只负责选默认人格，不得用于推断身份。
// 设计文档：docs/notes/implemented/architecture/2026-10-07-soul-system-v2-design.md。
export type Metadata = {
  id: string
  name: string
  displayName?: string
  commitPrefix?: string
  avatar?: string
  description?: string
}

// UI/客户端消费的轻量摘要：不携带正文，避免每次把几 KB Soul 传给客户端（设计 §9）。
export type Summary = {
  id: string
  name: string
  displayName: string
  commitPrefix: string
  avatar?: string
  description?: string
}

export const MAX_SOUL_DESCRIPTION_BYTES = 256

export type Info = Summary & {
  path: string
  content: string
}

// 坏 Soul 不崩整个 Registry：valid 正常列出，invalid 作为 issue 返回（设计 §39）。
export type Issue = {
  path: string
  message: string
}

// 文件硬上限（设计 §24）：超限整份拒绝加载，不静默截断人格正文。
export const MAX_SOUL_BYTES = 16 * 1024

// id 稳定机器标识：lowercase [a-z0-9-_]，全局唯一（设计 §6）。
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
