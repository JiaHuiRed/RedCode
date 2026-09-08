// 260909 Red 统一复制工具。clipboard API 在非 secure context（局域网 HTTP——手机/平板
// 经 Tailscale/LAN 访问 webui 的主用场景）下为 undefined 或 writeText 直接拒绝；
// execCommand("copy") 是唯一全环境可用路径。先走 execCommand（同步、无权限提示），
// 失败再退回 clipboard API；返回是否成功，调用方据此决定是否展示"已复制"反馈。
export async function copyText(text: string): Promise<boolean> {
  const body = typeof document === "undefined" ? undefined : document.body
  if (body) {
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    if (copied) return true
  }

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}
