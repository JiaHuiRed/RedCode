import { type JSX, type ComponentProps, For, Show } from "solid-js"
import "./meter.css"

export interface MeterSegment {
  /** 百分比 0-100，内部钳制；总和不齐 100 由容器 overflow 兜底 */
  value: number
  color: string
}

/**
 * 261106 Red 横向用量条。此前 app 里至少 4 处手搓同构的「track + 填充/分段」div
 * （session-context-usage 的悬浮条、session-context-tab 的配额条与构成/分解两处
 * 多段条），均无读屏语义。单值模式带 progressbar role 与 aria 值；多段模式的信息
 * 由相邻图例承载（现有调用点都有），条本身 aria-hidden。
 */
export function Meter(props: {
  /** 单值模式：百分比 0-100，内部钳制；与 segments 互斥，segments 优先 */
  value?: number
  /** 多段模式 */
  segments?: MeterSegment[]
  /** 单值模式的填充色 */
  color?: string
  /** 轨道背景色，默认 --surface-weak */
  track?: string
  /** thin = 4px（悬浮条），normal = 8px（面板条） */
  size?: "thin" | "normal"
  /** 单值模式下读屏文案 */
  label?: string
  class?: string
  classList?: ComponentProps<"div">["classList"]
  style?: JSX.CSSProperties
}) {
  const clamped = () => Math.min(100, Math.max(0, props.value ?? 0))
  const single = () => !props.segments
  return (
    <div
      data-component="meter"
      data-size={props.size ?? "normal"}
      role={single() ? "progressbar" : undefined}
      aria-valuemin={single() ? 0 : undefined}
      aria-valuemax={single() ? 100 : undefined}
      aria-valuenow={single() ? Math.round(clamped()) : undefined}
      aria-label={props.label}
      aria-hidden={single() ? undefined : "true"}
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
      style={{
        ...props.style,
        ...(props.track ? { "background-color": props.track } : {}),
      }}
    >
      <Show
        when={props.segments}
        fallback={<div data-slot="meter-fill" style={{ width: `${clamped()}%`, "background-color": props.color }} />}
      >
        <For each={props.segments}>
          {(segment) => (
            <div
              data-slot="meter-segment"
              style={{
                width: `${Math.min(100, Math.max(0, segment.value))}%`,
                "background-color": segment.color,
              }}
            />
          )}
        </For>
      </Show>
    </div>
  )
}
