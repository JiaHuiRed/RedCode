import { describe, expect, test } from "bun:test"
import { diffFingerprint, reviewedFiles } from "./review-progress"

const diff = (file: string, additions: number, deletions: number, status = "modified") => ({
  file,
  additions,
  deletions,
  status,
})

describe("review progress", () => {
  test("marks the files whose fingerprint still matches", () => {
    const diffs = [diff("a.ts", 3, 1), diff("b.ts", 5, 0)]
    const reviewed = { "a.ts": diffFingerprint(diffs[0]), "b.ts": diffFingerprint(diffs[1]) }
    expect(reviewedFiles(diffs, reviewed)).toEqual(["a.ts", "b.ts"])
  })

  test("a changed diff invalidates the old mark", () => {
    const before = diff("a.ts", 3, 1)
    const reviewed = { "a.ts": diffFingerprint(before) }
    expect(reviewedFiles([diff("a.ts", 9, 1)], reviewed)).toEqual([])
  })

  test("status changes also invalidate", () => {
    const reviewed = { "a.ts": diffFingerprint(diff("a.ts", 1, 0, "modified")) }
    expect(reviewedFiles([diff("a.ts", 1, 0, "added")], reviewed)).toEqual([])
  })

  test("unknown files are ignored", () => {
    expect(reviewedFiles([diff("a.ts", 1, 0)], { "c.ts": "modified:1:0" })).toEqual([])
  })
})
