import { For, type ComponentProps } from "solid-js"
import "./wordmark-v2.css"

const WORD = [
  { text: "RED", color: "#e84057" },
  { text: "CODE", color: "currentColor" },
] as const

// 260828 cc 字标从一整块纯文字改成逐字母入场。
//
// 之前是两个 <span> 的纯文字，静态。现在入场时字母逐个升起（stagger 40ms），吃
// prefers-reduced-motion。
//
// 260828 cc 试过再加一道每 8 秒横扫的白色高光（background-clip: text），**已删**：
// 白光扫过 RED 那三个字母时是拿白色盖住红色，读起来就是「红字突然闪一下」，
// 哥哥当场指出难看。常驻界面上的周期性闪动本来就很难做得不打扰，这个方向不对。
//
// 字距 0.35em 是它的识别度来源，不动；颜色分段（RED 红 / CODE 随当前色）同样不动 ——
// 那是品牌本身，动效只是包装。
//
// `animated={false}` 给不需要动的场合留口子（当前只有新建会话页用它，全部开着）。
export function WordmarkV2(props: Pick<ComponentProps<"span">, "class"> & { animated?: boolean }) {
  const animated = () => props.animated !== false
  const letters = () => {
    const out: { char: string; color: string; index: number }[] = []
    let index = 0
    for (const segment of WORD) {
      for (const char of segment.text) {
        out.push({ char, color: segment.color, index })
        index++
      }
    }
    return out
  }
  return (
    <span
      data-component="wordmark"
      style={{
        "font-family": "'Space Grotesk', sans-serif",
        "font-weight": 500,
        "letter-spacing": "0.35em",
        "text-transform": "uppercase",
        display: "inline-block",
      }}
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <For each={letters()}>
        {(letter) => (
          <span
            data-wordmark-letter={animated() ? "" : undefined}
            style={{
              color: letter.color,
              ...(animated() ? { "animation-delay": `${letter.index * 40}ms` } : {}),
            }}
          >
            {letter.char}
          </span>
        )}
      </For>
    </span>
  )
}
