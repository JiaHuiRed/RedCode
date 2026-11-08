// 261108 Red 组合输入状态的单一来源：键盘与滚动门禁共用，避免每处各挂一份 document 监听。
// 只回答「此刻是否在组合中」，不参与渲染；需要响应式的场景自行包一层信号。
let composing = false
let listening = false

function listen() {
  if (listening || typeof document === "undefined") return
  listening = true
  document.addEventListener("compositionstart", () => {
    composing = true
  })
  document.addEventListener("compositionend", () => {
    composing = false
  })
}

export function imeComposing() {
  listen()
  return composing
}
