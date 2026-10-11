import { describe, expect, test } from "bun:test"
import {
  GUI_DIAGNOSTICS_DEFAULT_LIMITS,
  anonKey,
  createGuiDiagnostics,
  hashId,
  maskText,
  type GuiDiagnosticRecord,
  type GuiDiagnostics,
} from "./gui-diagnostics"

const recordsOf = (g: GuiDiagnostics) => g.payload().records
const names = (g: GuiDiagnostics) => recordsOf(g).map((r) => r.name)

describe("gui-diagnostics 生命周期", () => {
  test("默认关闭：record 不产生任何记录", () => {
    const g = createGuiDiagnostics()
    expect(g.enabled()).toBe(false)
    g.record("ui.input", { name: "submit" })
    expect(g.count()).toBe(0)
    expect(recordsOf(g)).toHaveLength(0)
  })

  test("start 后记录，stop 后不再记录", () => {
    const g = createGuiDiagnostics()
    g.start()
    expect(g.enabled()).toBe(true)
    g.record("sse.flush", { name: "flush-1", duration: 12.345 })
    g.record("sse.flush", { name: "flush-2" })
    expect(g.count()).toBe(2)
    g.stop()
    expect(g.enabled()).toBe(false)
    g.record("sse.flush", { name: "flush-3" })
    expect(g.count()).toBe(2)
    expect(names(g)).toEqual(["flush-1", "flush-2"])
  })

  test("重新 start 清空上一次录制的缓冲", () => {
    const g = createGuiDiagnostics()
    g.start()
    g.record("ui.popover", { name: "a" })
    g.stop()
    g.start()
    expect(g.count()).toBe(0)
    expect(recordsOf(g)).toHaveLength(0)
  })
})

describe("有界环形缓冲", () => {
  test("超过 maxRecords 时淘汰最旧并计数", () => {
    const g = createGuiDiagnostics({ maxRecords: 3 })
    g.start()
    for (let i = 1; i <= 5; i++) g.record("ui.input", { name: `e${i}` })
    expect(g.count()).toBe(3)
    expect(names(g)).toEqual(["e3", "e4", "e5"])
    const counts = g.payload().counts
    expect(counts.total).toBe(5)
    expect(counts.kept).toBe(3)
    expect(counts.droppedRecords).toBe(2)
    expect(counts.droppedBytes).toBeGreaterThan(0)
  })

  test("超过 maxBytes 时按字节淘汰最旧", () => {
    const g = createGuiDiagnostics({ maxRecords: 100, maxBytes: 260 })
    g.start()
    for (let i = 1; i <= 4; i++) g.record("sse.flush", { name: `big${i}`, detail: { blob: "x".repeat(60) } })
    const list = recordsOf(g)
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list.length).toBeLessThan(4)
    expect(names(g).at(-1)).toBe("big4")
    expect(g.payload().counts.droppedRecords).toBe(4 - list.length)
  })

  test("单条超过 maxBytes 也至少保留一条", () => {
    const g = createGuiDiagnostics({ maxBytes: 10 })
    g.start()
    g.record("timeline.measure", { name: "huge", detail: { blob: "y".repeat(200) } })
    g.record("timeline.measure", { name: "after" })
    expect(names(g)).toEqual(["after"])
  })
})

describe("longtask 观察与降级", () => {
  test("没有 PerformanceObserver 时不抛错，其余记录照常", () => {
    const original = globalThis.PerformanceObserver
    // @ts-expect-error 测试内人为移除
    globalThis.PerformanceObserver = undefined
    try {
      const g = createGuiDiagnostics()
      g.start()
      g.record("ui.input", { name: "still-works" })
      expect(names(g)).toEqual(["still-works"])
      g.stop()
    } finally {
      globalThis.PerformanceObserver = original
    }
  })

  test("观察器回调转成 renderer.longtask 记录，stop 后断开", () => {
    type Listener = (list: { getEntries(): { name: string; duration: number }[] }) => void
    const instances: { listener: Listener; observed: boolean; disconnected: boolean }[] = []
    class FakeObserver {
      listener: Listener
      observed = false
      disconnected = false
      constructor(listener: Listener) {
        this.listener = listener
        instances.push(this)
      }
      observe() {
        this.observed = true
      }
      disconnect() {
        this.disconnected = true
      }
    }
    const original = globalThis.PerformanceObserver
    globalThis.PerformanceObserver = FakeObserver as unknown as typeof PerformanceObserver
    try {
      const g = createGuiDiagnostics()
      g.start()
      expect(instances).toHaveLength(1)
      expect(instances[0]!.observed).toBe(true)
      instances[0]!.listener({ getEntries: () => [{ name: "self", duration: 123.456 }] })
      const [rec] = recordsOf(g)
      expect(rec).toMatchObject({ type: "renderer.longtask", name: "self", duration: 123.46 })
      g.stop()
      expect(instances[0]!.disconnected).toBe(true)
    } finally {
      globalThis.PerformanceObserver = original
    }
  })
})

describe("隐私脱敏", () => {
  test("maskText 遮蔽绝对路径与凭据形态", () => {
    expect(maskText("C:\\Users\\Administrator\\my app\\file.ts")).toBe("<path>")
    expect(maskText("at foo (C:\\Users\\Administrator\\app\\x.ts:12:5)")).toBe("at foo (<path>)")
    // POSIX 规则同样贪婪（宁可多吃字符，不可漏——/Users/John Smith 这类含空格路径不能只剩前半段）
    expect(maskText("see /Users/bob/dev/app.ts ok")).toBe("see <path>")
    expect(maskText("Bearer abc.def-123")).toBe("Bearer <redacted>")
    expect(maskText("key sk-abcdefgh12345678 end")).toBe("key <redacted> end")
    expect(maskText("ghp_1234567890abcdef")).toBe("<redacted>")
    expect(maskText("mail user@example.com")).toBe("mail <email>")
    expect(maskText("plain text stays")).toBe("plain text stays")
  })

  test("maskText 截断长文本", () => {
    const out = maskText("a".repeat(400), 300)
    expect(out.length).toBe(301)
    expect(out.endsWith("…")).toBe(true)
  })

  test("hashId/anonKey 稳定且不泄露原文", () => {
    expect(hashId("dev")).toBe(hashId("dev"))
    expect(hashId("dev")).not.toBe(hashId("dev2"))
    expect(hashId("dev")).toMatch(/^[0-9a-f]{8}$/)
    expect(anonKey("D:\\secret\\path")).toMatch(/^anon-[0-9a-f]{8}$/)
    expect(anonKey("D:\\secret\\path")).not.toContain("secret")
  })

  test("detail 一律过脱敏与数值规整", () => {
    const g = createGuiDiagnostics()
    g.start()
    g.record("sync.bootstrap", {
      outcome: "error",
      detail: {
        path: "D:\\Users\\bob\\proj",
        token: "sk-1234567890abcdef",
        inf: Number.POSITIVE_INFINITY,
        num: 1.234567,
        ok: true,
      },
    })
    const [rec] = recordsOf(g) as [GuiDiagnosticRecord]
    expect(rec.detail).toEqual({ path: "<path>", token: "<redacted>", inf: 0, num: 1.23, ok: true })
  })
})

describe("导出载荷", () => {
  test("span/summary/counts/limits/meta 组装正确", () => {
    let t = 0
    const g = createGuiDiagnostics({ maxRecords: 7, maxBytes: 999, now: () => (t += 5) })
    g.start() // startedAt = 5
    g.record("sse.flush", { duration: 10 })
    g.record("sse.flush", { duration: 20 })
    g.record("sse.flush", { duration: 30 })
    g.record("sync.bootstrap", { name: "parked", outcome: "error" })
    const payload = g.payload({ version: "0.12.5", platform: "desktop" })
    expect(payload.schema).toBe("redcode.gui-diagnostics/v1")
    expect(payload.page).toEqual({ version: "0.12.5", platform: "desktop" })
    expect(payload.limits).toEqual({ maxRecords: 7, maxBytes: 999 })
    expect(payload.counts).toMatchObject({ total: 4, kept: 4, droppedRecords: 0 })
    expect(payload.summary.byType).toEqual({ "sse.flush": 3, "sync.bootstrap": 1 })
    expect(payload.summary.byOutcome).toEqual({ error: 1 })
    expect(payload.summary.durations["sse.flush"]).toEqual({ count: 3, min: 10, max: 30, avg: 20, p50: 20, p95: 30 })
    expect(payload.records[0]).toMatchObject({ at: 10, type: "sse.flush", duration: 10 })
    expect(payload.span.ms).toBeGreaterThan(0)
    expect(GUI_DIAGNOSTICS_DEFAULT_LIMITS.maxRecords).toBe(2000)
  })

  test("停止后 span 固定，不再增长", () => {
    let t = 0
    const g = createGuiDiagnostics({ now: () => (t += 10) })
    g.start() // startedAt = 10
    g.record("ui.input", { name: "a" }) // at = 20
    g.stop() // stoppedAt = 30
    const first = g.payload().span
    t += 1000
    expect(g.payload().span).toEqual(first)
    expect(first.ms).toBe(20)
  })
})
