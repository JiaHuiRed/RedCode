/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { Seal } from "@tui/component/seal"
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
