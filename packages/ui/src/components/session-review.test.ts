import { describe, test, expect } from "bun:test"
import { stepTarget } from "./session-review"

const files = ["a.ts", "b.ts", "c.ts"]

describe("stepTarget", () => {
  // 261110 Red 回归背景：step 曾只读 props.focusedFile 不回写，宿主 activeDiff
  // 停在旧值，连续 next 重复跳同一个文件。受控回写后导航链等价于下面的循环。
  test("连续 next×3 从无焦点依次推进到第三个文件", () => {
    let focused: string | undefined
    focused = stepTarget(files, focused, 1)
    expect(focused).toBe("a.ts")
    focused = stepTarget(files, focused, 1)
    expect(focused).toBe("b.ts")
    focused = stepTarget(files, focused, 1)
    expect(focused).toBe("c.ts")
  })

  test("反向 previous×2 依次回退；无焦点时从末尾开始", () => {
    let focused = stepTarget(files, undefined, -1)
    expect(focused).toBe("c.ts")
    focused = stepTarget(files, focused, -1)
    expect(focused).toBe("b.ts")
  })

  test("手动选中后继续导航从选中处推进，不重复当前文件", () => {
    let focused: string | undefined = "a.ts"
    focused = stepTarget(files, focused, 1)
    expect(focused).toBe("b.ts")
  })

  test("越界钳制在端点，不循环", () => {
    expect(stepTarget(files, "c.ts", 1)).toBe("c.ts")
    expect(stepTarget(files, "a.ts", -1)).toBe("a.ts")
  })

  test("焦点不在列表里视同无焦点", () => {
    expect(stepTarget(files, "removed.ts", 1)).toBe("a.ts")
    expect(stepTarget(files, "removed.ts", -1)).toBe("c.ts")
  })

  test("单文件原地不动，空列表返回 undefined", () => {
    expect(stepTarget(["only.ts"], "only.ts", 1)).toBe("only.ts")
    expect(stepTarget([], undefined, 1)).toBeUndefined()
  })
})
