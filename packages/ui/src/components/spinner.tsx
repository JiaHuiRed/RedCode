import { ComponentProps, For } from "solid-js"

const outerIndices = new Set([1, 2, 4, 7, 8, 11, 13, 14])
const cornerIndices = new Set([0, 3, 12, 15])
const squares = Array.from({ length: 16 }, (_, i) => ({
  id: i,
  x: (i % 4) * 4,
  y: Math.floor(i / 4) * 4,
  delay: Math.random() * 1.5,
  duration: 1 + Math.random() * 1,
  outer: outerIndices.has(i),
  corner: cornerIndices.has(i),
}))

// 261108 Red 每个点单独一层 <svg>（照搬上游 #61562）：合成器能跑 <svg> 元素本身的
// opacity 动画，跑不了 svg 内部 <rect> 的——以前 16 个 rect 同框，每帧重绘整张
// spinner；拆开后动画走合成器，不再触发重排/重绘。
export function Spinner(props: {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
}) {
  return (
    <span
      {...props}
      data-component="spinner"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
    >
      <For each={squares}>
        {(square) => (
          <svg
            viewBox="0 0 15 15"
            fill="currentColor"
            style={{
              opacity: square.corner ? 0 : undefined,
              animation: square.corner
                ? undefined
                : `${square.outer ? "pulse-opacity-dim" : "pulse-opacity"} ${square.duration}s ease-in-out infinite`,
              "animation-fill-mode": square.corner ? undefined : "both",
              "animation-delay": square.corner ? undefined : `${square.delay}s`,
            }}
          >
            <rect x={square.x} y={square.y} width="3" height="3" rx="1" />
          </svg>
        )}
      </For>
    </span>
  )
}
