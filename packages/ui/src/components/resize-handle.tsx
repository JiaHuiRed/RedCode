import { splitProps, type JSX } from "solid-js"

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  invert?: boolean
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  collapseThreshold?: number
}

/** 261024 Red 键盘微调步长：方向键一次挪 16px，Home/End 到两端。 */
const KEYBOARD_STEP = 16

/** 261024 Red 组件语义里的默认边：vertical=「start」（顶栏下沿的分隔条），horizontal=「end」。 */
function defaultEdge(direction: "horizontal" | "vertical", edge?: "start" | "end"): "start" | "end" {
  return edge ?? (direction === "vertical" ? "start" : "end")
}

/**
 * 261024 Red 拖拽位移 → 面板尺寸的**未夹紧**原始值：edge 决定跟随方向（start 侧把手向"内"
 * 拖是变大），invert 再整体翻转一次。折叠判定必须用它——夹紧值恒 ≥ min，terminal-panel
 * 传 min=100 / collapseThreshold=50，拿夹紧值比阈值手势恒不触发（ae87bde6 复审发现）。
 */
export function pointerResizeRaw(input: {
  direction: "horizontal" | "vertical"
  edge: "start" | "end"
  invert?: boolean
  start: number
  startSize: number
  pos: number
}): number {
  const raw = input.pos - input.start
  const delta =
    input.direction === "vertical"
      ? input.edge === "end"
        ? raw
        : -raw
      : input.edge === "start"
        ? -raw
        : raw
  const signed = input.invert ? -delta : delta
  return input.startSize + signed
}

/** 261024 Red 传给 onResize 的夹紧值：raw 限进 [min, max]。 */
export function pointerResizeSize(
  input: Parameters<typeof pointerResizeRaw>[0] & { min: number; max: number },
): number {
  return Math.min(input.max, Math.max(input.min, pointerResizeRaw(input)))
}

/**
 * 261024 Red 键盘等价物：方向键把分隔条沿屏幕方向挪一格，再过与拖拽**同一套** edge/invert
 * 换算——ArrowRight/Down 恒等于"向屏幕正方向拖"，start 侧就是收窄（session-side-panel 的
 * edge="start" 在旧映射下键盘与拖拽方向相反）。Home/End 到两端；其余键返回 undefined。
 */
export function keyboardResizeSize(input: {
  direction: "horizontal" | "vertical"
  key: string
  size: number
  min: number
  max: number
  edge?: "start" | "end"
  invert?: boolean
}): number | undefined {
  if (input.key === "Home") return input.min
  if (input.key === "End") return input.max
  const grow = input.direction === "horizontal" ? "ArrowRight" : "ArrowDown"
  const shrink = input.direction === "horizontal" ? "ArrowLeft" : "ArrowUp"
  if (input.key !== grow && input.key !== shrink) return undefined
  return pointerResizeSize({
    direction: input.direction,
    edge: defaultEdge(input.direction, input.edge),
    invert: input.invert,
    start: 0,
    startSize: input.size,
    pos: input.key === grow ? KEYBOARD_STEP : -KEYBOARD_STEP,
    min: input.min,
    max: input.max,
  })
}

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "invert",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "collapseThreshold",
    "class",
    "classList",
  ])

  // 261024 Red 拖拽状态收进一个可空对象：undefined = 未在拖拽。pointermove/up/cancel
  //   常驻在元素上（配合 pointer capture 把事件定向回把手），不再挂 document 级监听。
  let drag:
    | {
        edge: "start" | "end"
        start: number
        startSize: number
        /** 最近一次 pointermove 的指针位置；undefined 表示还没动过。 */
        lastPos?: number
        frame?: number
      }
    | undefined

  const sizeAt = (state: NonNullable<typeof drag>, pos: number) =>
    pointerResizeSize({
      direction: local.direction,
      edge: state.edge,
      invert: local.invert,
      start: state.start,
      startSize: state.startSize,
      pos,
      min: local.min,
      max: local.max,
    })

  // 261024 Red 折叠判定走未夹紧值：sizeAt 恒 ≥ min，collapseThreshold < min 的调用方
  //   （terminal-panel 50 < 100）拿夹紧值比永远不成立，拖拽折叠手势曾因此被无声消除。
  const sizeRaw = (state: NonNullable<typeof drag>, pos: number) =>
    pointerResizeRaw({
      direction: local.direction,
      edge: state.edge,
      invert: local.invert,
      start: state.start,
      startSize: state.startSize,
      pos,
    })

  const handlePointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    // 只认主键：原 mouse 版连右键/中键按下也会进入拖拽。
    if (event.button !== 0) return
    event.preventDefault()
    drag = {
      edge: defaultEdge(local.direction, local.edge),
      start: local.direction === "horizontal" ? event.clientX : event.clientY,
      startSize: local.size,
    }
    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent) => {
    const state = drag
    if (!state) return
    state.lastPos = local.direction === "horizontal" ? event.clientX : event.clientY
    if (state.frame !== undefined) return
    // 261024 Red rAF 合帧：move 只记最新位置，每帧最多一次 onResize。高 Hz 鼠标原先每个
    //   事件都直灌 onResize → layout store → 依赖宽度的整列 relayout，120Hz 下每秒 120+ 次。
    state.frame = requestAnimationFrame(() => {
      const current = drag
      if (!current) return
      current.frame = undefined
      if (current.lastPos !== undefined) local.onResize(sizeAt(current, current.lastPos))
    })
  }

  const finishDrag = () => {
    const state = drag
    if (!state) return
    drag = undefined
    if (state.frame !== undefined) cancelAnimationFrame(state.frame)
    // 松手提交最终尺寸：合帧后最后一次 move 可能还悬在下一帧，这里立即落账，
    // 保证 collapse 判定与最终 onResize 用同一份最新尺寸。
    if (state.lastPos !== undefined) local.onResize(sizeAt(state, state.lastPos))
    document.body.style.userSelect = ""
    document.body.style.overflow = ""
    const threshold = local.collapseThreshold ?? 0
    if (local.onCollapse && threshold > 0 && sizeRaw(state, state.lastPos ?? state.start) < threshold) {
      local.onCollapse()
    }
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const next = keyboardResizeSize({
      direction: local.direction,
      key: event.key,
      size: local.size,
      min: local.min,
      max: local.max,
      edge: defaultEdge(local.direction, local.edge),
      invert: local.invert,
    })
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    local.onResize(next)
  }

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={defaultEdge(local.direction, local.edge)}
      // 261024 Red 键盘入口：可聚焦 separator + 方向键/Home/End。注意 ARIA 的 orientation
      //   描述的是分隔线本身的走向：横向拖拽的把手是一条竖线 → orientation="vertical"，
      //   与 keyboardResizeSize 的左右键映射一致。
      role="separator"
      aria-orientation={local.direction === "horizontal" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(local.size)}
      aria-valuemin={local.min}
      aria-valuemax={local.max}
      tabindex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onKeyDown={handleKeyDown}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    />
  )
}
