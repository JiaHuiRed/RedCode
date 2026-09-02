import { Slider as Kobalte } from "@kobalte/core/slider"
import { For, Show, createSignal, onCleanup, splitProps, type JSX } from "solid-js"
import "./effort-slider-v2.css"

export interface EffortSliderV2Props {
  /** 从低到高排好序的档位。少于两档时不渲染——一档没什么可滑的。 */
  steps: readonly string[]
  /** 当前档位。不在 steps 里时落到第 0 档（模型换了、旧档位失效的过渡帧）。 */
  current: string
  onChange: (value: string) => void
  /** 档位显示名。不给就用原值。 */
  label?: (value: string) => string
  /** 无障碍名，落到 aria-label。 */
  title?: string
  class?: string
  /** 尺寸走 --effort-slider-v2-width / --effort-slider-v2-height 两个自定义属性。 */
  style?: JSX.CSSProperties
}

/**
 * 260902 cc 推理强度滑杆。
 *
 * 档位集合是**每个模型自己的**（transform.ts：openai 是 minimal/low/medium/high/xhigh，
 * deepseek 是 low/high/max，anthropic 系压根没有这一维），所以刻度数必须由 steps.length
 * 决定，不能写死。少于两档直接不渲染，交由调用方决定要不要留位。
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

export function EffortSliderV2(props: EffortSliderV2Props) {
  const [local] = splitProps(props, ["steps", "current", "onChange", "label", "title", "class", "style"])

  /** 拖动中的连续值；不在拖动时是 undefined，位置由 current 决定。 */
  const [drag, setDrag] = createSignal<number | undefined>()

  const last = () => local.steps.length - 1
  const committed = () => {
    const found = local.steps.indexOf(local.current)
    return found >= 0 ? found : 0
  }
  const position = () => drag() ?? committed()
  const text = (value: string) => (local.label ? local.label(value) : value)
  /** 拖动中标签跟最近的一档走，不然读数会是 2.37 这种不存在的值。 */
  const nearest = () => local.steps[Math.round(position())] ?? local.current

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
      commit(committed() + delta)
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
    <Show when={local.steps.length > 1}>
      <Kobalte
        ref={bindKeys}
        data-slot="effort-slider-v2"
        data-dragging={drag() !== undefined ? "" : undefined}
        class={local.class}
        style={local.style}
        aria-label={local.title}
        minValue={0}
        maxValue={last()}
        step={STEP}
        value={[position()]}
        getValueLabel={() => text(nearest())}
        onChange={(next) => setDrag(next[0] ?? 0)}
        onChangeEnd={(next) => {
          // 先落 drag 再提交：先提交的话这一帧 data-dragging 还在，吸附那段过渡会被吃掉。
          setDrag(undefined)
          commit(next[0] ?? 0)
        }}
      >
        {/* 没有 Kobalte.Fill 是刻意的。Fill 只能长在 Track 里，而 Track 被内缩了半个滑块宽
            （否则滑块滑到两端会探出胶囊外），Fill 跟着内缩就会在左端留一截填不到的空当。
            档位进度由"点亮到第几个刻度"表达，够用，也比一条强调色的填充更安静。 */}
        <Kobalte.Track data-slot="effort-slider-v2-track">
          {/* 刻度只是视觉提示，不接事件——点击/拖拽全部由 Track 处理，
              盖在上面的元素若吃掉 pointer 事件，点到刻度上就滑不动了。 */}
          <div data-slot="effort-slider-v2-ticks" aria-hidden="true">
            <For each={local.steps}>{(_, i) => <span data-on={i() <= Math.round(position()) ? "" : undefined} />}</For>
          </div>
          <Kobalte.Thumb data-slot="effort-slider-v2-thumb">
            <Kobalte.Input />
          </Kobalte.Thumb>
        </Kobalte.Track>
      </Kobalte>
    </Show>
  )
}
