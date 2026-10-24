import { Slider as Kobalte } from "@kobalte/core/slider"
import { For, Show, createSignal, onCleanup, splitProps, type JSX } from "solid-js"
import "./effort-slider-v2.css"

export interface EffortSliderV2Props {
  /** 从低到高排好序的真实档位。0 档不渲染，1 档显示按钮，2 档及以上显示滑杆。 */
  steps: readonly string[]
  /** 当前显式档位。未设置时保留模型默认，不选中任何刻度。 */
  current?: string
  onChange: (value: string) => void
  /** 档位显示名。不给就用原值。 */
  label?: (value: string) => string
  /** 无障碍名，落到 aria-label。 */
  title?: string
  /** 未显式选择时只提供给辅助技术的值名，不在界面显示。 */
  unselectedLabel?: string
  class?: string
  /** 尺寸走 --effort-slider-v2-width / --effort-slider-v2-height / --effort-slider-v2-thumb-size。 */
  style?: JSX.CSSProperties
}

export const availableEffortSteps = (steps: readonly string[]) => steps.filter((step) => step !== "default")

export const selectedEffortIndex = (steps: readonly string[], current?: string) =>
  current === undefined ? -1 : steps.indexOf(current)

/**
 * 260902 cc 推理强度滑杆。
 *
 * 档位集合是**每个模型自己的**（transform.ts：openai 是 minimal/low/medium/high/xhigh，
 * deepseek 是 low/high/max，anthropic 系压根没有这一维），所以刻度数必须由 steps.length
 * 决定，不能写死。单档用按钮呈现，多档才是滑杆。
 *
 * 值域用**下标**而不是档位名：Kobalte 的 Slider 只吃数字，档位名与下标的换算收在这里，
 * 对外仍然只交换字符串，调用方不用知道有下标这回事。
 *
 * ## 为什么不是 step=1
 *
 * 最初 step=1 + 给 left 加 CSS 过渡，实测仍然是"一闪而过"：档位之间隔着 40px，
 * 无论缓动多久，滑块都是**离开手指自己跑过去**的，手感是跳不是滑。
 *
 * 现在拖动阶段用细步长（STEP），滑块严格跟手；松手才 round 到最近一档提交，
 * 那一下吸附由 CSS 过渡收尾。拖动中必须关掉过渡（data-dragging），否则滑块会拖在
 * 指针后面，比跳还难受。
 *
 * 代价是键盘：Kobalte 的方向键按 step 走，细步长下一次只挪 1%。所以键盘在根节点上
 * 捕获阶段自己接管，按整档走。
 */
const STEP = 0.01

/**
 * 261024 Red 光点（sparkle）布点：x/y 是胶囊内的百分比位置，s 是相对滑杆高度的尺寸，
 * o 是基础不透明度，d 是满档闪烁的相位错峰（负延迟直接落在动画中段）。显隐阈值在
 * 渲染时取 x + 6%：光点亮起的那一刻填充刚好追上它，不会浮在未填充的轨道上。
 */
const SPARKLES = [
  { x: 14, y: 30, s: 0.18, o: 0.75, d: -0.2 },
  { x: 25, y: 62, s: 0.24, o: 0.9, d: -1.1 },
  { x: 34, y: 24, s: 0.15, o: 0.6, d: -0.7 },
  { x: 46, y: 55, s: 0.26, o: 0.95, d: -1.6 },
  { x: 57, y: 30, s: 0.17, o: 0.7, d: -0.45 },
  { x: 67, y: 62, s: 0.22, o: 0.85, d: -1.3 },
  { x: 78, y: 34, s: 0.16, o: 0.65, d: -0.9 },
  { x: 87, y: 55, s: 0.24, o: 0.9, d: -0.55 },
]

const sparkleStyle = (spark: (typeof SPARKLES)[number]) => ({
  "--spark-x": `${spark.x}%`,
  "--spark-y": `${spark.y}%`,
  "--spark-s": `${spark.s}`,
  "--spark-o": `${spark.o}`,
  "--spark-t": `${(spark.x / 100 + 0.06).toFixed(2)}`,
  "--spark-d": `${spark.d}s`,
})

export function EffortSliderV2(props: EffortSliderV2Props) {
  const [local] = splitProps(props, [
    "steps",
    "current",
    "onChange",
    "label",
    "title",
    "unselectedLabel",
    "class",
    "style",
  ])

  /** 拖动中的连续值；不在拖动时是 undefined，位置由 current 决定。 */
  const [drag, setDrag] = createSignal<number | undefined>()

  const last = () => local.steps.length - 1
  const committed = () => selectedEffortIndex(local.steps, local.current)
  const position = () => drag() ?? Math.max(committed(), 0)
  const hasSelection = () => drag() !== undefined || committed() >= 0
  const activeIndex = () => (drag() === undefined ? committed() : Math.round(position()))
  const text = (value: string) => (local.label ? local.label(value) : value)
  /** 拖动中标签跟最近的一档走，不然读数会是 2.37 这种不存在的值。 */
  const nearest = () => local.steps[Math.round(position())] ?? local.current ?? ""
  /** 261024 Red 档位在全程里的位置（0..1），驱动渐变揭示与光点显隐。 */
  const progress = () => position() / last()

  const commit = (raw: number) => {
    const index = Math.max(0, Math.min(last(), Math.round(raw)))
    const value = local.steps[index]
    if (value !== undefined && value !== local.current) local.onChange(value)
  }

  const KEY_DELTA: Record<string, number> = {
    ArrowLeft: -1,
    ArrowDown: -1,
    ArrowRight: 1,
    ArrowUp: 1,
  }

  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (event.key === "Home") {
      commit(0)
    } else if (event.key === "End") {
      commit(last())
    } else {
      const delta = KEY_DELTA[event.key]
      if (delta === undefined) return
      commit((committed() < 0 ? -1 : committed()) + delta)
    }
    // 拦在捕获阶段：不拦的话 Kobalte 自己的方向键处理会按 STEP 再挪 1%。
    event.preventDefault()
    event.stopPropagation()
  }

  const bindKeys = (el: HTMLElement) => {
    el.addEventListener("keydown", onKeyDownCapture, true)
    onCleanup(() => el.removeEventListener("keydown", onKeyDownCapture, true))
  }

  return (
    <Show when={local.steps.length > 0}>
      <Show
        when={local.steps.length > 1}
        fallback={
          <button
            type="button"
            data-slot="effort-slider-v2-single"
            data-selected={local.current === local.steps[0] ? "" : undefined}
            aria-pressed={local.current === local.steps[0]}
            class={local.class}
            style={local.style}
            onClick={() => {
              const step = local.steps[0]
              if (step !== undefined) local.onChange(step)
            }}
          >
            {text(local.steps[0] ?? "")}
          </button>
        }
      >
        <Kobalte
          ref={bindKeys}
          data-slot="effort-slider-v2"
          data-dragging={drag() !== undefined ? "" : undefined}
          data-unselected={hasSelection() ? undefined : ""}
          data-max={hasSelection() && position() >= last() ? "" : undefined}
          class={local.class}
          style={{ ...local.style, "--effort-progress": progress() }}
          aria-label={local.title}
          minValue={0}
          maxValue={last()}
          step={STEP}
          value={[position()]}
          getValueLabel={() => (hasSelection() ? text(nearest()) : (local.unselectedLabel ?? ""))}
          onChange={(next) => setDrag(next[0] ?? 0)}
          onChangeEnd={(next) => {
            // 先落 drag 再提交：先提交的话这一帧 data-dragging 还在，吸附那段过渡会被吃掉。
            setDrag(undefined)
            commit(next[0] ?? 0)
          }}
        >
          {/* 260930 Red 填充单独贴满胶囊，避免内缩 Track 留白；只裁剪填充，不裁剪圆形滑块。
              261024 Red 填充改为固定多段渐变 + clip-path 揭示：原先 scaleX 会把渐变一起压扁，
              揭示式才是「低档只见绿，每升一档多展开一截蓝/紫」的递进观感。光点随档位浮现。 */}
          <div data-slot="effort-slider-v2-fill-clip" aria-hidden="true">
            <div data-slot="effort-slider-v2-fill" />
            <div data-slot="effort-slider-v2-sparkles" aria-hidden="true">
              <For each={SPARKLES}>{(spark) => <span style={sparkleStyle(spark)} />}</For>
            </div>
          </div>
          <Kobalte.Track data-slot="effort-slider-v2-track">
            {/* 刻度只是视觉提示，不接事件——点击/拖拽全部由 Track 处理，
                盖在上面的元素若吃掉 pointer 事件，点到刻度上就滑不动了。 */}
            <div data-slot="effort-slider-v2-ticks" aria-hidden="true">
              <For each={local.steps}>
                {(_, i) => (
                  <span
                    data-on={activeIndex() >= 0 && i() <= activeIndex() ? "" : undefined}
                    data-current={activeIndex() === i() ? "" : undefined}
                  />
                )}
              </For>
            </div>
            <Kobalte.Thumb data-slot="effort-slider-v2-thumb">
              <Kobalte.Input />
            </Kobalte.Thumb>
          </Kobalte.Track>
        </Kobalte>
      </Show>
    </Show>
  )
}
