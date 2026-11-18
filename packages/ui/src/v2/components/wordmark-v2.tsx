import { For, type ComponentProps } from "solid-js"
import "./wordmark-v2.css"

const WORD = [
  { text: "RED", color: "#e84057", treatment: "gradient" },
  { text: "SPACE", color: "currentColor", treatment: "outline" },
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
// 261118 RedSpace 品牌迁移：欢迎页改为 REDSPACE；新字标比 REDCODE 多一个字母，
// 字距从 0.35em 收到 0.26em，避免窄窗溢出。RED 实心渐变、SPACE 浅色空心描边，
// 延续原版逐字母入场；动画只是包装，品牌与角色图标各自独立。
//
// 260915 Red 字面从「纯双色平涂」升级为「实心渐变 + 描边空心」的双重对比：
// RED 用纵向渐变（猩红→品牌红→深红）加底部柔辉（drop-shadow，暗壁纸上把字托起来；
// 不用 text-shadow——background-clip: text 下 text-shadow 会透出填充，字会糊）；
// CODE 原先改透明填充 + currentColor 描边；RedSpace 的 SPACE 继承这一效果。描边用 -webkit-text-fill-color 而不是
// color: transparent 做镂空——text-stroke-color 的 currentColor 按 color 属性解析，
// color 一旦 transparent 描边就跟着没了。宽度用 0.03em 随字号缩放（88px 下约 2.6px）。
// 字体、分段着色与逐字母入场继续保留。
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
          filter: "drop-shadow(0 0 0.055em rgba(255, 241, 248, 0.42)) drop-shadow(0 0 0.17em rgba(255, 147, 176, 0.23))",
        }
      : {
          color: letter.color,
          "background-image": "linear-gradient(180deg, #ff5a6e 0%, #e84057 55%, #c9203f 100%)",
          "-webkit-background-clip": "text",
          "background-clip": "text",
          "-webkit-text-fill-color": "transparent",
          filter: "drop-shadow(0 0 0.06em rgba(255, 80, 116, 0.55)) drop-shadow(0 0.07em 0.22em rgba(232, 64, 87, 0.35))",
        }
  return (
    <span
      data-component="wordmark"
      role="img"
      aria-label="REDSPACE"
      style={{
        "font-family": "'Space Grotesk', sans-serif",
        "font-weight": 500,
        "letter-spacing": "var(--wordmark-tracking)",
        "white-space": "nowrap",
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
            {letter.char === "A" ? (
              // 261118 Red 用合并后的轮廓替代字体的重叠描边，避免横梁穿进斜腿。
              <svg
                class="wordmark-outline-glyph"
                viewBox="0 0 67 76"
                width="0.67em"
                height="0.76em"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                aria-hidden="true"
              >
                <path d="M2 74 26 2h15l24 72H52l-6.5-20h-24L15 74Z M24.5 44h18L33.5 15Z" />
              </svg>
            ) : (
              letter.char
            )}
          </span>
        )}
      </For>
    </span>
  )
}
