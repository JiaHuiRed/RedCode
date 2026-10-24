import { showToast } from "@redcode-ai/ui/toast"
import { formatServerError, type Translator } from "./server-errors"

/**
 * 261024 Red 服务端请求失败的统一错误 toast：variant/title/description 三元组此前
 * 复制散落（session.tsx、session-status-tab 等），收敛在这里。标题或兜底文案确实
 * 不同的调用方走 options；描述不是 formatServerError 产物的（自定义展示）别硬套。
 */
export function notifyServerError(translate: Translator, error: unknown, options?: { title?: string; fallback?: string }) {
  showToast({
    variant: "error",
    title: options?.title ?? translate("common.requestFailed"),
    description: formatServerError(error, translate, options?.fallback),
  })
}
