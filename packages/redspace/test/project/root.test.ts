import { describe, expect, test } from "bun:test"
import { projectRoot } from "../../src/project/root"

describe("projectRoot", () => {
  test("returns worktree when it is a real project root", () => {
    const ctx = { worktree: "D:\\AI\\project", directory: "D:\\AI\\project\\subdir" }
    expect(projectRoot(ctx)).toBe("D:\\AI\\project")
  })

  test("falls back to directory when worktree is filesystem root posix", () => {
    const ctx = { worktree: "/", directory: "D:\\AI\\project\\subdir" }
    expect(projectRoot(ctx)).toBe("D:\\AI\\project\\subdir")
  })

  test("falls back to directory when worktree is filesystem root windows", () => {
    const ctx = { worktree: "D:\\", directory: "D:\\AI\\project\\subdir" }
    expect(projectRoot(ctx)).toBe("D:\\AI\\project\\subdir")
  })

  test("falls back to directory when worktree is empty", () => {
    const ctx = { worktree: "", directory: "D:\\AI\\project\\subdir" }
    expect(projectRoot(ctx)).toBe("D:\\AI\\project\\subdir")
  })
})
