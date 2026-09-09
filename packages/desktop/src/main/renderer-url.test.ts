import { describe, expect, test } from "bun:test"
import { isTrustedRendererUrl } from "./renderer-url"

describe("trusted renderer URLs", () => {
  test("accepts only the packaged renderer protocol and host", () => {
    expect(isTrustedRendererUrl("oc://renderer/index.html")).toBe(true)
    expect(isTrustedRendererUrl("oc://other/index.html")).toBe(false)
    expect(isTrustedRendererUrl("oc://renderer/index.html", true)).toBe(true)
    expect(isTrustedRendererUrl("oc://renderer/assets/app.js", true)).toBe(false)
  })

  test("accepts only the configured development origin", () => {
    const devUrl = "http://127.0.0.1:5173"

    expect(isTrustedRendererUrl("http://127.0.0.1:5173/index.html", false, devUrl)).toBe(true)
    expect(isTrustedRendererUrl("http://127.0.0.1:5174/index.html", false, devUrl)).toBe(false)
    expect(isTrustedRendererUrl("https://127.0.0.1:5173/index.html", false, devUrl)).toBe(false)
  })

  test("rejects invalid URLs", () => {
    expect(isTrustedRendererUrl("not a url")).toBe(false)
    expect(isTrustedRendererUrl()).toBe(false)
  })
})
