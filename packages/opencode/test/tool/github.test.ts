import { describe, expect, test } from "bun:test"
import {
  capBytes,
  capText,
  formatIssue,
  formatListRows,
  formatPr,
  formatReviewComments,
  Parameters,
} from "@/tool/github"
import { Schema } from "effect"

// 261024 Red github 工具的纯函数面：截断边界、格式化输出、参数 schema。
// spawn 不进测试面（会碰真 gh 与网络）；runGh 的错误分支靠首用实测。

describe("capText / capBytes", () => {
  test("short text passes through untouched", () => {
    expect(capText("hello", 100)).toBe("hello")
    expect(capBytes("hello", 1000)).toBe("hello")
  })

  test("long text is cut with a truncation marker", () => {
    const cut = capText("a".repeat(2500), 1000)
    expect(cut.startsWith("a".repeat(1000))).toBe(true)
    expect(cut).toContain("truncated 1500 chars")
  })

  test("diff is bounded by bytes, not chars", () => {
    // 每字 3 字节的中文：40k 字 = 120KB，超过 50KB 上限
    const big = "汉".repeat(40_000)
    const cut = capBytes(big, 50 * 1024)
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(50 * 1024 + 80)
    expect(cut).toContain("truncated at")
  })
})

describe("formatPr", () => {
  test("renders metadata line, stats and capped body", () => {
    const out = formatPr({
      number: 12,
      title: "Fix ResizeHandle",
      state: "OPEN",
      isDraft: true,
      author: { login: "red" },
      baseRefName: "dev",
      headRefName: "fix/handle",
      additions: 10,
      deletions: 4,
      changedFiles: 2,
      body: "x".repeat(5000),
      url: "https://example.com/pr/12",
    })
    expect(out).toContain("#12 Fix ResizeHandle [draft] (OPEN)")
    expect(out).toContain("+10/-4 across 2 files")
    expect(out).toContain("truncated 1000 chars")
    expect(out).toContain("https://example.com/pr/12")
  })
})

describe("formatReviewComments", () => {
  test("maps inline comments to path:line anchors and caps bodies", () => {
    const out = formatReviewComments([
      { path: "src/ui.tsx", line: 42, body: "y".repeat(2000), user: { login: "reviewer" } },
      { path: "src/a.ts", original_line: 7, body: "nit", user: { login: "bot" } },
    ])
    expect(out).toContain("reviewer @ src/ui.tsx:42")
    expect(out).toContain("truncated 800 chars")
    expect(out).toContain("bot @ src/a.ts:7")
  })

  test("caps comment count and says how many were omitted", () => {
    const comments = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.ts`, line: i, body: "ok" }))
    const out = formatReviewComments(comments)
    expect(out).toContain("10 more comments omitted")
    expect(out).not.toContain("f39.ts")
  })

  test("empty set is explicit", () => {
    expect(formatReviewComments([])).toBe("(no inline review comments)")
  })
})

describe("formatIssue", () => {
  test("body plus capped comments", () => {
    const out = formatIssue(
      { number: 3, title: "Crash on switch", state: "OPEN", body: "steps…", author: { login: "u" } },
      [{ author: { login: "v" }, body: "repro'd" }],
    )
    expect(out).toContain("#3 Crash on switch (OPEN)")
    expect(out).toContain("## comments")
    expect(out).toContain("v:")
    expect(out).toContain("repro'd")
  })
})

describe("formatListRows", () => {
  test("rows and empty state", () => {
    expect(formatListRows([{ number: 1, title: "A", author: { login: "x" } }])).toBe("#1 A — x")
    expect(formatListRows([])).toBe("(none)")
  })
})

describe("Parameters schema", () => {
  test("accepts list without number and rejects pr without it only at execute time", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({ operation: "list", kind: "issue", limit: 10 })
    expect(decoded.operation).toBe("list")
  })
})
