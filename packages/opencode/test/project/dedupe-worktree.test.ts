// 260814 Red 同 worktree 多行 project 的去重判据（真实数据形态见 docs/notes 的同名 note）
import { describe, expect, test } from "bun:test"
import { dedupeByWorktree } from "@/project/project"

type Row = { id: string; worktree: string; time_created?: number | null }

// 测试里路径已是绝对路径，resolve 用恒等即可——被测的是"留哪行"，不是 path 语义
const identity = (p: string) => p
const counts = (map: Record<string, number>) => (id: string) => map[id] ?? 0

describe("dedupeByWorktree", () => {
  test("keeps the row with more sessions, not the newer one", () => {
    // RedClaw 的真实形态：旧行有会话、新行是 .git 重建后的空行
    const rows: Row[] = [
      { id: "9965e80f", worktree: "D:\\AI\\RedClaw", time_created: 1_780_039_458_305 },
      { id: "f6dd362d", worktree: "D:\\AI\\RedClaw", time_created: 1_786_154_616_921 },
    ]
    const kept = dedupeByWorktree(rows, counts({ "9965e80f": 1, f6dd362d: 0 }), identity)
    expect(kept.map((r) => r.id)).toEqual(["9965e80f"])
  })

  test("keeps the git-derived row over the abandoned path fallback", () => {
    // attendance/financialcost 的真实形态：path- 回落行空置，根提交行承载会话
    const rows: Row[] = [
      { id: "path-234ba6ac", worktree: "D:\\KLX\\CWB\\attendance", time_created: 1_785_133_299_984 },
      { id: "176d6f2c", worktree: "D:\\KLX\\CWB\\attendance", time_created: 1_786_154_613_438 },
    ]
    const kept = dedupeByWorktree(rows, counts({ "path-234ba6ac": 0, "176d6f2c": 2 }), identity)
    expect(kept.map((r) => r.id)).toEqual(["176d6f2c"])
  })

  test("breaks a session-count tie by the newer row", () => {
    const rows: Row[] = [
      { id: "old", worktree: "D:\\x", time_created: 100 },
      { id: "new", worktree: "D:\\x", time_created: 200 },
    ]
    expect(dedupeByWorktree(rows, counts({}), identity).map((r) => r.id)).toEqual(["new"])
  })

  test("normalizes separators, case, and trailing slashes", () => {
    const rows: Row[] = [
      { id: "a", worktree: "D:\\AI\\RedCode", time_created: 100 },
      { id: "b", worktree: "d:/ai/redcode/", time_created: 200 },
    ]
    expect(dedupeByWorktree(rows, counts({ a: 3, b: 0 }), identity)).toHaveLength(1)
  })

  test("leaves distinct worktrees untouched and preserves their order", () => {
    const rows: Row[] = [
      { id: "a", worktree: "D:\\one" },
      { id: "b", worktree: "D:\\two" },
      { id: "c", worktree: "D:\\three" },
    ]
    expect(dedupeByWorktree(rows, counts({}), identity).map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  test("missing time_created does not beat a row that has one", () => {
    const rows: Row[] = [
      { id: "dated", worktree: "D:\\x", time_created: 500 },
      { id: "undated", worktree: "D:\\x", time_created: null },
    ]
    expect(dedupeByWorktree(rows, counts({}), identity).map((r) => r.id)).toEqual(["dated"])
  })
})
