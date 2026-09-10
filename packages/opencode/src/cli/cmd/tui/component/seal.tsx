/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { For, createMemo } from "solid-js"
import { useTheme } from "@tui/context/theme"

/**
 * 朱印 · 终端刻本。
 *
 * 260904 cc 品牌标志的终端版。GUI 侧走的是 SVG（`packages/ui/src/assets/brand/redcode-mark*.svg`，
 * 实心印身 + 挖空的 `>_` + 右上崩口 + 印边留白），那套几何**搬不进终端**：
 * 试过把 SVG 栅格化再用半块字符 `▀▄█` 铺（一格装两个垂直像素，正好凑出方像素），
 * 但 `>` 的笔画在 16 列下只有 1.7 个像素宽，`_` 直接消失，要到 24 列 × 12 行才看得清 ——
 * 而首页字标本身才 7 行。
 *
 * 所以终端这版是**线条刻本**，不是栅格化的产物：
 *   · 印身用圆角框字符，比例上 6 列 × 3 行在终端里就是视觉正方形（字符约 1:2）
 *   · 印文直接写 `>_` —— 它本来就是终端提示符，用真字符比栅格成色块更本真
 *   · 右上崩口**有意舍弃**：试过用断笔 `╸` 开口，出来像画错了而不是手刻残缺，
 *     那个特征需要亚字符级精度，终端给不了
 *
 * 静态不动是有意的：印是盖上去的落款，字标那边已经有常驻扫光，再让印晃会打架。
 */
const LINES = ["╭────╮", "│ >_ │", "╰────╯"] as const

// 260910 Red 紧凑档改为**实心印**（会话页脚）：实心印身 + 印文挖空成底色，与 GUI 品牌标
// （redcode-mark*.svg：实心印身、`>_` 挖空、印边留白）同构，也是「朱印」本来的样子。
// 上一版是线条框 `╭───╮ / ╰ >_╯`——5 列 × 2 行里印文必然咬掉一条边框（终端字符格无法再细分），
// 底边于是成了破口，看着不像印。宽度与印文列位是设计约束，导出供测试钉住。
// 260910 Red: 5 列太宽——终端字符约 1:2，5 列 × 2 行视觉上是 5:4 的横长方形，
// `>_` 只占中间 2 列、左右各空 1.5 格，印身显得空、印文显得小（哥哥："朱印太大，
// 里面的 >_ 很不协调"）。收成 4 列 × 2 行：4:4 正好视觉正方形，`>_` 居中占一半宽。
// 宽度与印文列位是设计约束，导出供测试钉住。
export const COMPACT_SEAL_WIDTH = 4
// `>_` 左右各留 1 格居中。
export const COMPACT_SEAL_TEXT = " >_ "

/** 主色 / 深色界面用色，与 redcode-mark.svg 头部注释同源 */
const INK_LIGHT = RGBA.fromHex("#C8322B")
const INK_DARK = RGBA.fromHex("#E4534A")

function brandInk(background: RGBA, override?: RGBA) {
  if (override) return override
  const luma = background.r * 0.299 + background.g * 0.587 + background.b * 0.114
  return luma < 0.5 ? INK_DARK : INK_LIGHT
}

export function Seal(props: { ink?: RGBA; size?: "full" | "compact" }) {
  const { theme } = useTheme()

  // 品牌色不跟主题调色板走（那是标志不是 UI 元素），但深色底上 #C8322B 压不住，
  // 按背景亮度在两档官方用色之间切一次。RGBA 分量是 0–1。
  const ink = createMemo(() => brandInk(theme.background, props.ink))

  // 紧凑档：两行实心块，第二行用底色写字＝挖空印文（同 MIME 徽标的底色挖空手法）。
  if (props.size === "compact") {
    return (
      <box flexDirection="column" flexShrink={0}>
        <text>
          <span style={{ bg: ink() }}>{" ".repeat(COMPACT_SEAL_WIDTH)}</span>
        </text>
        <text>
          <span style={{ bg: ink(), fg: theme.background }}>{COMPACT_SEAL_TEXT}</span>
        </text>
      </box>
    )
  }

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={LINES}>{(line) => <text fg={ink()}>{line}</text>}</For>
    </box>
  )
}
