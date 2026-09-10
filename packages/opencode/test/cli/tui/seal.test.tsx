/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { COMPACT_SEAL_TEXT, COMPACT_SEAL_WIDTH, Seal } from "@tui/component/seal"
import { destroyFrame, renderFrame } from "./lib/transcript"

afterEach(destroyFrame)

// 260904 cc 朱印是设计产物，形状改了应该被看见而不是悄悄漂移。
// 尺寸这条单独断言：终端字符约 1:2，6 列 × 3 行才是视觉正方形，
// 任何一边动了都不再是"方印"。
test("朱印整帧", async () => {
  const frame = await renderFrame(() => <Seal />, { width: 12, height: 4 })
  expect(frame).toMatchSnapshot()
})

test("朱印是 6 列 × 3 行的方印，印文是终端提示符", async () => {
  const frame = await renderFrame(() => <Seal />, { width: 12, height: 4 })
  const lines = frame.split("\n")
  expect(lines).toHaveLength(3)
  for (const line of lines) expect([...line].length).toBe(6)
  expect(lines[1]).toContain(">_")
})

// 260910 Red 紧凑档是**实心印**：印身由背景色铺满、印文用底色挖空。字符帧抓不到背景色，
// 所以宽度与列位直接钉导出常量，帧里验行数与印文落点。
test("朱印紧凑档是 4 列 × 2 行的实心印，印文在印身内居中", async () => {
  const frame = await renderFrame(() => <Seal size="compact" />, { width: 12, height: 4 })
  const lines = frame.split("\n")
  expect(lines).toHaveLength(2)
  expect(COMPACT_SEAL_WIDTH).toBe(4)
  // 260910 Red: 紧凑印 4 列、全尺寸 6 列（多出的两列是边框），绝对列号不再可比。
  // 居中落在常量上（`>_` 左右各留 1 格）——帧渲染会裁掉行首空白，不能从帧里断言空格。
  expect(COMPACT_SEAL_TEXT).toBe(" >_ ")
  expect(lines[1]).toContain(">_")
})
