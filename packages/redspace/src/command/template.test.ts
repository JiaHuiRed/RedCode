import { describe, expect, test } from "bun:test"
import { resolveTemplate } from "./template"

// 261024 Red MCP prompt 懒模板在 HTTP 边界落地为字符串的契约：
// 字符串直通、已决取值、拒绝/挂起兜底 ""。见 template.ts 头注释。

describe("resolveTemplate", () => {
  test("passes strings through untouched", async () => {
    expect(await resolveTemplate("hello")).toBe("hello")
    expect(await resolveTemplate("")).toBe("")
  })

  test("awaits resolved promises", async () => {
    expect(await resolveTemplate(Promise.resolve("resolved"))).toBe("resolved")
  })

  test("rejected promises fall back to empty string", async () => {
    expect(await resolveTemplate(Promise.reject(new Error("server unavailable")))).toBe("")
  })

  test("pending promises fall back after the budget", async () => {
    const pending = new Promise<string>(() => {})
    const start = Date.now()
    expect(await resolveTemplate(pending, 30)).toBe("")
    expect(Date.now() - start).toBeGreaterThanOrEqual(20)
  })
})
