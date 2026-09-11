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

// 260910 Red 紧凑档（会话页脚）压成**单行实心印**：对应 GUI 的
// `redcode-mark-simple.svg`（16px 档去掉印边留白与崩口，那个尺寸下留白只会让边缘发毛）——
// 紧凑档就该是它的终端刻本。
//
// 为什么不是 2 行：页脚那行文字只有 1 行高，flex 居中的取整对「偶数高的印
// vs 奇数高的文字」必然落到某一行，印总是多探出半行。上两版（5 列 × 2 行、4 列 × 2 行）
// 哥哥都反馈「agent 前面的朱印偏高」，根因不是列宽与内部留白，是**行数不匹配**。
// 压成 1 行后印与文字同高，对齐不再是取整问题。
// 260911 Red 右侧补一列实心留白，保留 `>_` 原位，只把印身稍微加宽。
// 宽度与印文是设计约束，导出供测试钉住。
export const COMPACT_SEAL_WIDTH = 3
export const COMPACT_SEAL_TEXT = ">_ "

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

  // 紧凑档：单行实心块，印文用底色挖空（同 MIME 徽标的底色挖空手法）。
  if (props.size === "compact") {
    return (
      <box flexShrink={0}>
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
