import { randomUUID } from "crypto"

// 261116 Red A03：用户对运行中子任务的「补充要求」。草稿按目标会话落格，关闭对话框、
// 切回主会话再回来都还在；requestID 是服务端的幂等键——同一正文重试沿用原 ID，
// 正文改了才换新 ID（服务端会对「同 ID 不同正文」拒绝）。
export const STEER_MESSAGE_MAX_BYTES = 16_384
export const STEER_REQUEST_ID_MAX_BYTES = 256

export type SteerDraft = { text: string; requestID: string; requestText?: string }

const drafts = new Map<string, SteerDraft>()

export function getSteerDraft(sessionID: string): SteerDraft {
  const existing = drafts.get(sessionID)
  if (existing) return existing
  const created: SteerDraft = { text: "", requestID: randomUUID() }
  drafts.set(sessionID, created)
  return created
}

// 编辑中的正文变化只更新文本，不动 requestID；是否换 ID 在真正发送时判定。
export function saveSteerText(sessionID: string, text: string) {
  const current = getSteerDraft(sessionID)
  if (current.text === text) return current
  const next: SteerDraft = { ...current, text }
  drafts.set(sessionID, next)
  return next
}

export function steerRequest(sessionID: string, text: string): SteerDraft {
  const current = getSteerDraft(sessionID)
  if (current.requestText === text) return { ...current, text }
  const next: SteerDraft = { text, requestID: randomUUID(), requestText: text }
  drafts.set(sessionID, next)
  return next
}

export function clearSteerDraft(sessionID: string) {
  drafts.delete(sessionID)
}

// 仅测试用：清空模块级草稿格，避免用例之间互相串。
export function resetSteerDrafts() {
  drafts.clear()
}

export function validateSteerMessage(text: string, requestID: string) {
  if (!text.trim()) return "补充要求不能为空"
  if (Buffer.byteLength(text, "utf8") > STEER_MESSAGE_MAX_BYTES) return `补充要求超过 ${STEER_MESSAGE_MAX_BYTES} 字节上限`
  if (Buffer.byteLength(requestID, "utf8") > STEER_REQUEST_ID_MAX_BYTES) return "requestID 超过长度上限"
  return undefined
}

export type SteerDelivery = "queued" | "delivered"

// 已送达只说明投递成功，不等于模型已理解或执行完成；消息里 delivery 只有 delivered
// 才算「送达」，其余（queued / pending_steer / steer / 未标注）都按「已排队」展示。
export function steerDelivery(delivery: string | undefined): SteerDelivery {
  return delivery === "delivered" ? "delivered" : "queued"
}

export function steerStateText(state: SteerDelivery | "sending" | "failed") {
  switch (state) {
    case "sending":
      return "发送中…"
    case "queued":
      return "已排队：在下一个安全执行点送达，不会打断正在运行的工具"
    case "delivered":
      return "已送达：只代表投递成功，不代表模型已理解或执行完成"
    case "failed":
      return "发送失败：原文已保留，可重试"
  }
}
