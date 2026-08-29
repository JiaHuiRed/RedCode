// 260829 cc 让 v2 色板跟着主题走。
//
// 背景：v2 的 60 个语义 token（--v2-background-*、--v2-text-*、--v2-border-* …）全都是
// 指向一条原始色阶的引用（--v2-grey-N、--v2-alpha-light-N、--v2-alpha-dark-N），而那条
// 色阶只按 data-color-scheme 分 light/dark/cream/green/deepblue 五档，**不认 theme**。
// 于是 yuqi 这种有色相的主题在 v2 面上一直吃灰阶，只能靠 app/index.css 里手写一段覆盖
// 顶着（260823，11 个 token），剩下 49 个照旧发灰 —— 一屏上因此同时存在 v1 生成的色相
// 与 v2 的灰阶两套颜色。
//
// 做法：不动那 60 个语义 token，只把它们底下的原始色阶按主题重新生成一份，用 :root
// 覆盖 colors.css 里 @layer theme 的默认值（无层样式胜过有层样式，天然赢）。一处改动，
// 60 个 token 全部跟着主题走。
//
// 三条设计约束，改这里之前先读：
//
// 1. **明度曲线一律不动。** 生成出来的每一档都保持 colors.css 原本那一档的 OKLCH L，
//    只换 H、加 C。v2 的深浅两个块是按这条明度阶挑档位的（bg-base 取 grey-1000、
//    text-base 取 grey-200…），对比度全靠它；动了 L 等于动了整套无障碍前提。
//
// 2. **彩度必须随明度收敛**，公式 c = neutral.c × 0.75 × 4L(1-L)：中段着色最重、纯白纯黑
//    收敛回无彩。这不是拍脑袋——是拿 260823 那份手调的 yuqi 覆盖做的拟合，8 个档里 6 个
//    误差 < 0.002。直接用 neutral.c 不衰减的话，暗端会出 #15010e 这种发紫发脏的东西
//    （手调那边暗端实测只有 C≈0.032，而 neutral 自己是 0.075）。
//
// 3. **无彩度主题必须逐字节还原。** neutral 的彩度低于阈值时整个函数返回空串，一个变量
//    都不发。默认主题 oc-2 的 neutral 是 #1f1f1f（C=0.000），实测套公式还原最大单通道
//    漂移为 0 —— 但仍然走空串这条路，省掉 30 个主题里绝大多数的无谓覆盖。
import { hexToOklch, oklchToHex } from "./color"
import type { HexColor } from "./types"

/** 与 v2/styles/colors.css 的 `── Grey ──` 一节逐档对应。改那边要同步改这里。 */
const GREY: Record<number, string> = {
  100: "#ffffff",
  200: "#fafafa",
  300: "#eeeeee",
  400: "#d4d4d4",
  500: "#aeaeae",
  600: "#808080",
  700: "#5c5c5c",
  800: "#3a3a3a",
  900: "#242424",
  1000: "#161616",
  1100: "#080808",
  1200: "#000000",
}

/** alpha 两条阶的档位，同样与 colors.css 对应。 */
const ALPHA = [100, 90, 80, 70, 60, 50, 40, 30, 24, 20, 16, 14, 12, 10, 8, 6, 4, 2, 0]

/** 低于这个彩度就当作中性主题，不发任何覆盖（见上面约束 3）。 */
const ACHROMATIC = 0.005

/** 中段着色强度。0.75 是对 260823 手调 yuqi 覆盖的拟合结果，别随手动。 */
const TINT = 0.75

/** alpha 阶的着色比中段弱一档：它们是描边与蒙版，吃满彩度会让边框显脏。 */
const ALPHA_TINT = 0.5

const hex6 = (value: string) => value.slice(0, 7)

const alphaHex = (percent: number) =>
  Math.round((percent * 255) / 100)
    .toString(16)
    .padStart(2, "0")

export function v2NeutralsToCss(neutral: HexColor): string {
  const base = hexToOklch(neutral)
  if (!Number.isFinite(base.c) || base.c < ACHROMATIC) return ""

  const lines: string[] = []

  for (const [step, hex] of Object.entries(GREY)) {
    const { l } = hexToOklch(hex as HexColor)
    // 4l(1-l) 等价于 1-(2l-1)^2：L=0.5 处取 1，两端归零。
    const c = base.c * TINT * 4 * l * (1 - l)
    lines.push(`--v2-grey-${step}: ${hex6(oklchToHex({ l, c, h: base.h }))};`)
  }

  // alpha 阶的本体是「近白」与「近黑」，只给它们上色相，明度沿用原本的极值。
  const light = hex6(oklchToHex({ l: 0.97, c: base.c * ALPHA_TINT, h: base.h }))
  const dark = hex6(oklchToHex({ l: 0.12, c: base.c * ALPHA_TINT, h: base.h }))
  for (const step of ALPHA) {
    lines.push(`--v2-alpha-light-${step}: ${light}${alphaHex(step)};`)
    lines.push(`--v2-alpha-dark-${step}: ${dark}${alphaHex(step)};`)
  }

  return lines.join("\n  ")
}
