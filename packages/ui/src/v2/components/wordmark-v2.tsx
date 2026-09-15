import { For, type ComponentProps } from "solid-js"
import "./wordmark-v2.css"

const WORD = [
  { text: "RED", color: "#e84057", treatment: "gradient" },
  { text: "CODE", color: "currentColor", treatment: "outline" },
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
// 260915 Red 字面从「纯双色平涂」升级为「实心渐变 + 描边空心」的双重对比：
// RED 用纵向渐变（猩红→品牌红→深红）加底部柔辉（drop-shadow，暗壁纸上把字托起来；
// 不用 text-shadow——background-clip: text 下 text-shadow 会透出填充，字会糊）；
// CODE 改透明填充 + currentColor 描边。描边用 -webkit-text-fill-color 而不是
// color: transparent 做镂空——text-stroke-color 的 currentColor 按 color 属性解析，
// color 一旦 transparent 描边就跟着没了。宽度用 0.03em 随字号缩放（88px 下约 2.6px）。
// 字距、字体、分段、逐字母入场全部不动。
//
// `animated={false}` 给不需要动的场合留口子（当前只有新建会话页用它，全部开着）。
export function WordmarkV2(props: Pick<ComponentProps<"span">, "class"> & { animated?: boolean }) {
  const animated = () => props.animated !== false
  const letters = () => {
    const out: { char: string; color: string; index: number; treatment: string }[] = []
    let index = 0
    for (const segment of WORD) {
      for (const char of segment.text) {
        out.push({ char, color: segment.color, index, treatment: segment.treatment })
        index++
      }
    }
    return out
  }
  const letterStyle = (letter: { color: string; treatment: string }) =>
    letter.treatment === "outline"
      ? {
          color: letter.color,
          "-webkit-text-stroke": "0.03em currentColor",
          "-webkit-text-fill-color": "transparent",
        }
      : {
          color: letter.color,
          "background-image": "linear-gradient(180deg, #ff5a6e 0%, #e84057 55%, #c9203f 100%)",
          "-webkit-background-clip": "text",
          "background-clip": "text",
          "-webkit-text-fill-color": "transparent",
          filter: "drop-shadow(0 0.07em 0.22em rgba(232, 64, 87, 0.35))",
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
              ...letterStyle(letter),
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
