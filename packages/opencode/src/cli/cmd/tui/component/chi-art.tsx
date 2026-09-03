import { RGBA } from "@opentui/core"
import { createMemo, For } from "solid-js"
import { tint, useTheme } from "@tui/context/theme"
import { CHI_ART_COLS, CHI_ART_ROWS, CHI_ART_RGB_BASE64 } from "./chi-art-data"

/** 上半格实心块：前景色画上半像素，背景色露出下半像素。 */
const HALF = "▀"

/**
 * 数据里存的是去饱和后的原色，**没有压暗**——压暗要以主题背景为锚。
 *
 * 直接乘个系数在深色主题下没问题，但 TUI 有二十多个主题、其中有浅色的，那样会在浅底上
 * 拍出一块黑洞。改成从主题背景往原色混合：深色主题里结果与「乘 0.7」几乎一致，
 * 浅色主题里自动变成浅色版本，始终跟底色同族。
 */
const MIX = 0.7

function decode(): Uint8Array {
  const bin = atob(CHI_ART_RGB_BASE64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const PIXELS = decode()

/**
 * 看板娘「赤」的半格字符画。22 列 × 11 行。
 *
 * 一个单元格 = 两个上下堆叠的像素（`▀` 的前景/背景），所以 22×22 像素铺成 22×11 格，
 * 像素是方的。整张图标缩到这个尺寸五官会糊，数据取的是脸部特写，见 chi-art-data.ts。
 */
export function ChiArt(props: { class?: string }) {
  const { theme } = useTheme()

  const rows = createMemo(() => {
    const at = (x: number, y: number) => {
      const i = (y * CHI_ART_COLS + x) * 3
      const src = RGBA.fromInts(PIXELS[i]!, PIXELS[i + 1]!, PIXELS[i + 2]!)
      return tint(theme.background, src, MIX)
    }
    return Array.from({ length: CHI_ART_ROWS }, (_, row) =>
      Array.from({ length: CHI_ART_COLS }, (_, x) => ({ fg: at(x, row * 2), bg: at(x, row * 2 + 1) })),
    )
  })

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={rows()}>
        {(line) => (
          <box flexDirection="row" height={1}>
            <For each={line}>
              {(cell) => (
                <text fg={cell.fg} bg={cell.bg} selectable={false}>
                  {HALF}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
