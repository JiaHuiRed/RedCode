import { describe, test, expect } from "bun:test"
import { nextUnreviewedTarget, reviewTotals, stepTarget } from "./session-review"

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

describe("reviewTotals", () => {
  // 261115 Red A-UX-04：全批审完的收尾汇总。只数看过的规模，binary 或缺失计数的
  // 文件仍计文件数、行数按 0 计。
  test("sums files and line counts", () => {
    expect(reviewTotals([{ additions: 3, deletions: 1 }, { additions: 0, deletions: 2 }, {}])).toEqual({
      files: 3,
      additions: 3,
      deletions: 3,
    })
  })

  test("empty list yields zeros", () => {
    expect(reviewTotals([])).toEqual({ files: 0, additions: 0, deletions: 0 })
  })
})

describe("nextUnreviewedTarget", () => {
  // 261115 Red UX-16：标记并下一个——从当前文件之后（含环绕）找第一个未审文件，
  // current 本身刚被标记，永远排除。
  test("从当前文件之后找第一个未审，跳过已审文件", () => {
    expect(nextUnreviewedTarget(files, new Set(["a.ts"]), "a.ts")).toBe("b.ts")
    expect(nextUnreviewedTarget(files, new Set(["a.ts", "b.ts"]), "a.ts")).toBe("c.ts")
  })

  test("尾部环绕到开头", () => {
    expect(nextUnreviewedTarget(files, new Set(["a.ts", "b.ts"]), "b.ts")).toBe("c.ts")
    expect(nextUnreviewedTarget(files, new Set(["b.ts", "c.ts"]), "c.ts")).toBe("a.ts")
  })

  test("无焦点或焦点不在列表时从头扫全部", () => {
    expect(nextUnreviewedTarget(files, new Set(["a.ts"]), undefined)).toBe("b.ts")
    expect(nextUnreviewedTarget(files, new Set(["a.ts"]), "removed.ts")).toBe("b.ts")
  })

  test("current 刚标记也要排除；全审完返回 undefined", () => {
    expect(nextUnreviewedTarget(["only.ts"], new Set(), "only.ts")).toBeUndefined()
    expect(nextUnreviewedTarget(files, new Set(["a.ts", "b.ts", "c.ts"]), "b.ts")).toBeUndefined()
    expect(nextUnreviewedTarget([], new Set(), undefined)).toBeUndefined()
  })
})
