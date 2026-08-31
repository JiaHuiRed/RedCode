/**
 * 玻璃清单 ⑤：光标 spotlight 辉光。
 *
 * 底本是 DSH Aqua 插件（`E:\AI\DSH-Transparent-UI-Plugin`）从 deepseek.com 官方特性卡
 * 移植的那个 hover 交互：一团跟着光标走的径向辉光，压在玻璃**背后**（`z-index: -1`），
 * 于是它透过半透明面漫开、永远不会盖住内容。
 *
 * 本仓只做一处，挂在 `<main data-frost-surface="main">` 上。原因是 DOM 上
 * `#file-tree-panel` / `#review-panel` / `[data-frost-surface="home-sidebar"]` 全是 main
 * 的后代：`z-index: -1` 的子元素画在**父元素背景之上、父元素内容之下**（CSS 绘制序），
 * 所以一团辉光就同时垫在上面每一层玻璃底下——既覆盖全应用，又不会像逐面板各挂一个那样
 * 在重叠处叠成两倍亮。
 *
 * 逐帧只改 transform，不重画渐变：辉光元素是一个 2×半径 的定尺方块、渐变只栅格化一次，
 * 位置靠 `--spot-x/y` 驱动 transform。若照 Aqua 那样每帧重写整块 background-image，
 * 重画面积等于整个 main（窗口大小），代价高一个量级。
 *
 * 几何量每次 hover 只测一次（`pointerenter` 时），逐帧路径零布局读取；面板尺寸变化由
 * ResizeObserver 作废缓存——审查栏/文件树是可拖拽改宽的，不作废会让辉光整体偏移。
 */
export function trackSpotlight(pane: HTMLElement, glow: HTMLElement) {
  let rect: DOMRect | undefined
  let frame = 0
  let clientX = 0
  let clientY = 0

  const flush = () => {
    frame = 0
    if (!rect) return
    glow.style.setProperty("--spot-x", `${clientX - rect.left}px`)
    glow.style.setProperty("--spot-y", `${clientY - rect.top}px`)
  }

  const move = (event: PointerEvent) => {
    clientX = event.clientX
    clientY = event.clientY
    if (!rect) rect = pane.getBoundingClientRect()
    if (!frame) frame = requestAnimationFrame(flush)
  }

  const enter = (event: PointerEvent) => {
    rect = pane.getBoundingClientRect()
    move(event)
    glow.setAttribute("data-on", "")
  }

  const leave = () => {
    glow.removeAttribute("data-on")
    rect = undefined
  }

  // pointerenter / pointerleave 不冒泡，且把后代算作本元素内部——正是这里要的语义
  // （光标在文件树与聊天区之间移动不该反复熄灭再点亮）。pointermove 冒泡，落在 main 上
  // 就能收到子元素上的移动。
  pane.addEventListener("pointerenter", enter)
  pane.addEventListener("pointerleave", leave)
  pane.addEventListener("pointermove", move, { passive: true })

  const observer = new ResizeObserver(() => {
    rect = undefined
  })
  observer.observe(pane)

  return () => {
    if (frame) cancelAnimationFrame(frame)
    observer.disconnect()
    pane.removeEventListener("pointerenter", enter)
    pane.removeEventListener("pointerleave", leave)
    pane.removeEventListener("pointermove", move)
  }
}
