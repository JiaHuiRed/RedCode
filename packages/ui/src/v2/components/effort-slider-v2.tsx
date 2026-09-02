import { Slider as Kobalte } from "@kobalte/core/slider"
import { For, Show, splitProps } from "solid-js"
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
 */
export function EffortSliderV2(props: EffortSliderV2Props) {
  const [local] = splitProps(props, ["steps", "current", "onChange", "label", "title", "class"])

  const index = () => {
    const found = local.steps.indexOf(local.current)
    return found >= 0 ? found : 0
  }
  const text = (value: string) => (local.label ? local.label(value) : value)

  return (
    <Show when={local.steps.length > 1}>
      <Kobalte
        data-slot="effort-slider-v2"
        class={local.class}
        aria-label={local.title}
        minValue={0}
        maxValue={local.steps.length - 1}
        step={1}
        value={[index()]}
        getValueLabel={() => text(local.current)}
        onChange={(next) => {
          const value = local.steps[next[0] ?? 0]
          if (value !== undefined && value !== local.current) local.onChange(value)
        }}
      >
        {/* 没有 Kobalte.Fill 是刻意的。Fill 只能长在 Track 里，而 Track 被内缩了半个滑块宽
            （否则滑块滑到两端会探出胶囊外），Fill 跟着内缩就会在左端留一截填不到的空当。
            档位进度由"点亮到第几个刻度"表达，够用，也比一条强调色的填充更安静。 */}
        <Kobalte.Track data-slot="effort-slider-v2-track">
          {/* 刻度只是视觉提示，不接事件——点击/拖拽全部由 Track 处理，
              盖在上面的元素若吃掉 pointer 事件，点到刻度上就滑不动了。 */}
          <div data-slot="effort-slider-v2-ticks" aria-hidden="true">
            <For each={local.steps}>{(_, i) => <span data-on={i() <= index() ? "" : undefined} />}</For>
          </div>
          <Kobalte.Thumb data-slot="effort-slider-v2-thumb">
            <Kobalte.Input />
          </Kobalte.Thumb>
        </Kobalte.Track>
      </Kobalte>
    </Show>
  )
}
