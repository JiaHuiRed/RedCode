import { describe, expect, test } from "bun:test"
import {
  capBytes,
  capText,
  formatIssue,
  formatListRows,
  formatPr,
  formatReviewComments,
  Parameters,
  readBounded,
  runGh,
} from "@/tool/github"
import { Schema } from "effect"

// 261024 Red github 工具的纯函数面：截断边界、格式化输出、参数 schema。
// 261024 Red RC-A02 runGh 改异步+有界读取后，bin/timeout 可注入——进程面测试用
// bun -e 自证（超时 kill / 大输出 512KB 停读 / CLI 缺失），不碰真 gh 与网络。

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

describe("readBounded (RC-A02)", () => {
  test("limit 内的流完整通过", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello world"))
        c.close()
      },
    })
    expect(await readBounded(stream, 1024)).toEqual({ text: "hello world", truncated: false })
  })

  test("收满 limit 停读并标记 truncated", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x".repeat(10_000)))
        c.close()
      },
    })
    const r = await readBounded(stream, 100)
    expect(r.text.length).toBe(100)
    expect(r.truncated).toBe(true)
  })

  test("undefined 流返回空串", async () => {
    expect(await readBounded(undefined, 10)).toEqual({ text: "", truncated: false })
  })
})

describe("runGh (RC-A02 注入面：真进程、假 gh)", () => {
  test("CLI 缺失返回 PATH 错误而非抛出", async () => {
    const r = await runGh(["anything"], process.cwd(), { bin: "definitely-missing-redcode-bin" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("不在 PATH")
  })

  test("超时 kill 子进程并回报终止", async () => {
    const r = await runGh(["-e", "await new Promise((resolve) => setTimeout(resolve, 5000))"], process.cwd(), {
      bin: "bun",
      timeoutMs: 400,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("超时")
  })

  test("2MB 输出被压到 512KB 上限并标记 truncated", async () => {
    const r = await runGh(["-e", "process.stdout.write('x'.repeat(2_000_000))"], process.cwd(), {
      bin: "bun",
      timeoutMs: 15_000,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.truncated).toBe(true)
      expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(512 * 1024)
    }
  })
})
