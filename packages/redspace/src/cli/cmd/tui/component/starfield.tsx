import {
  FrameBufferRenderable,
  RGBA,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core"
import { extend } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { StarfieldPainter } from "./starfield-render"

// 260701 Red 首页背景星空点缀，挂在 Logo 后面（见 routes/home.tsx）
type StarfieldOptions = RenderableOptions<FrameBufferRenderable> & { base?: RGBA }

class StarfieldRenderable extends FrameBufferRenderable {
  private painter = new StarfieldPainter()

  constructor(ctx: RenderContext, options: StarfieldOptions = {}) {
    const width = typeof options.width === "number" ? options.width : 1
    const height = typeof options.height === "number" ? options.height : 1
    super(ctx, { ...options, width, height, live: false, respectAlpha: true })
    if (options.width !== undefined && typeof options.width !== "number") this.width = options.width
    if (options.height !== undefined && typeof options.height !== "number") this.height = options.height
    this.painter.setBase(options.base)
  }

  set base(value: RGBA | undefined) {
    if (this.painter.setBase(value)) this.requestRender()
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible || this.isDestroyed) return
    this.painter.render(this.frameBuffer)
    super.renderSelf(buffer)
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    starfield: typeof StarfieldRenderable
  }
}

extend({ starfield: StarfieldRenderable })

// 260701 Red 手动低频 requestRender（~700ms 一次）代替 live:true 常驻 60fps 循环——
// 首页是长时间挂着的常驻界面，不像 BgPulse 那样只在弹窗时短暂显示，全速刷新没必要且费电。
const TICK_MS = 700

export function Starfield() {
  const { theme } = useTheme()
  let ref: StarfieldRenderable | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    timer = setInterval(() => ref?.requestRender(), TICK_MS)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <starfield ref={(item: StarfieldRenderable) => (ref = item)} width="100%" height="100%" base={theme.textMuted} />
  )
}
