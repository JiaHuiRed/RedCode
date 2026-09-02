import { describe, expect, test } from "bun:test"
import { sseErrorText, sseLogLine } from "./sse-log"

describe("sseErrorText", () => {
  test("Error 保留 name 与 message", () => {
    expect(sseErrorText(new TypeError("Failed to fetch"))).toBe("TypeError: Failed to fetch")
  })

  test("cause 链跟着展开——SSE 断连的真因常常在 cause 里", () => {
    const err = new Error("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:63615") })
    expect(sseErrorText(err)).toBe("Error: fetch failed <- Error: ECONNREFUSED 127.0.0.1:63615")
  })

  test("Response 这类对象挑出能定位问题的字段", () => {
    expect(sseErrorText({ status: 502, statusText: "Bad Gateway" })).toBe("status=502 statusText=Bad Gateway")
  })

  test("认不出字段的对象退回 JSON，而不是 [object Object]", () => {
    expect(sseErrorText({ foo: 1 })).toBe('{"foo":1}')
  })

  test("循环引用不炸，退到 toString", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic
    expect(sseErrorText(cyclic)).toBe("[object Object]")
  })

  test("null / undefined / 原始值各有可读表示", () => {
    expect(sseErrorText(null)).toBe("null")
    expect(sseErrorText(undefined)).toBe("undefined")
    expect(sseErrorText("boom")).toBe("boom")
  })
})

describe("sseLogLine", () => {
  test("字段拍进消息字符串本身，不依赖控制台序列化对象", () => {
    const line = sseLogLine("[global-sdk]", "event stream error", {
      url: "http://127.0.0.1:63615",
      fetch: "platform",
      error: new TypeError("Failed to fetch"),
    })
    expect(line).toBe(
      "[global-sdk] event stream error url=http://127.0.0.1:63615 fetch=platform error=TypeError: Failed to fetch",
    )
    // 这条断言是本文件存在的理由：整行必须不含 [object Object]
    expect(line).not.toContain("[object Object]")
  })

  test("undefined 字段略过", () => {
    expect(sseLogLine("[t]", "m", { a: 1, b: undefined })).toBe("[t] m a=1")
  })

  test("没有字段时不留尾随空格", () => {
    expect(sseLogLine("[t]", "m", {})).toBe("[t] m")
  })
})
