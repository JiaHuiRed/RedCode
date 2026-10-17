import { test, expect, describe, afterEach } from "bun:test"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { parseRedirectUri } from "../../src/mcp/oauth-provider"

describe("parseRedirectUri", () => {
  test("returns defaults when no URI provided", () => {
    const result = parseRedirectUri()
    expect(result.port).toBe(19876)
    expect(result.path).toBe("/mcp/oauth/callback")
  })

  test("parses port and path from URI", () => {
    const result = parseRedirectUri("http://127.0.0.1:8080/oauth/callback")
    expect(result.port).toBe(8080)
    expect(result.path).toBe("/oauth/callback")
  })

  test("returns defaults for invalid URI", () => {
    const result = parseRedirectUri("not-a-valid-url")
    expect(result.port).toBe(19876)
    expect(result.path).toBe("/mcp/oauth/callback")
  })
})

describe("McpOAuthCallback.ensureRunning", () => {
 afterEach(async () => {
   await McpOAuthCallback.stop()
 })

 test("starts server with custom redirectUri port and path", async () => {
   await McpOAuthCallback.ensureRunning("http://127.0.0.1:18000/custom/callback")
   expect(McpOAuthCallback.isRunning()).toBe(true)
 })
})

describe("McpOAuthCallback.waitForCallback rejection safety", () => {
 afterEach(async () => {
   await McpOAuthCallback.stop()
 })

 test("cancelPending rejects to an awaiting consumer", async () => {
   const promise = McpOAuthCallback.waitForCallback("state-a", "mcp-a")
   McpOAuthCallback.cancelPending("mcp-a")
   const message = await promise.then(
     () => "resolved",
     (err: Error) => err.message,
   )
   expect(message).toBe("Authorization cancelled")
 })

 test("stop() rejection with no consumer never becomes unhandled", async () => {
   const unhandled: unknown[] = []
   const onUnhandled = (reason: unknown) => unhandled.push(reason)
   process.on("unhandledRejection", onUnhandled)
   // 模拟调用方在 await 前被中断：只创建 promise，不 await
   const promise = McpOAuthCallback.waitForCallback("state-b", "mcp-b")
   await McpOAuthCallback.stop()
   await new Promise((resolve) => setTimeout(resolve, 20))
   process.off("unhandledRejection", onUnhandled)
   expect(unhandled).toEqual([])
   // 迟到的消费者仍能收到原始 rejection
   const message = await promise.then(
     () => "resolved",
     (err: Error) => err.message,
   )
    expect(message).toBe("OAuth callback server stopped")
  })
})

describe("McpOAuthCallback.handleRequest security", () => {
  afterEach(async () => {
    await McpOAuthCallback.stop()
  })

  const callback = (port: number, query: string) => fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?${query}`)

  test("rejects a callback whose state is not pending", async () => {
    await McpOAuthCallback.ensureRunning("http://127.0.0.1:18001/mcp/oauth/callback")
    const response = await callback(18001, "error=access_denied&error_description=leaked&state=not-pending")
    expect(response.status).toBe(400)
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'")
    // 261017 Red 无效 state 时连错误文本都不渲染，避免变成任意文本的展示面
    expect(await response.text()).not.toContain("leaked")
  })

  test("escapes error text but still rejects the pending auth", async () => {
    await McpOAuthCallback.ensureRunning("http://127.0.0.1:18002/mcp/oauth/callback")
    const pending = McpOAuthCallback.waitForCallback("state-esc")
    const payload = "<script>alert(1)</script>"
    const response = await callback(
      18002,
      `state=state-esc&error=invalid&error_description=${encodeURIComponent(payload)}`,
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain("&lt;script&gt;")
    expect(body).not.toContain("<script>alert")
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(await pending.then(() => "resolved", (err: Error) => err.message)).toBe(payload)
  })

  test("rejects a callback without state", async () => {
    await McpOAuthCallback.ensureRunning("http://127.0.0.1:18003/mcp/oauth/callback")
    const response = await callback(18003, "error=denied")
    expect(response.status).toBe(400)
  })

  test("success page keeps the auto-close script allowed by its hash", async () => {
    await McpOAuthCallback.ensureRunning("http://127.0.0.1:18004/mcp/oauth/callback")
    const pending = McpOAuthCallback.waitForCallback("state-ok")
    const response = await callback(18004, "state=state-ok&code=abc")
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain("Authorization Successful")
    expect(await pending).toBe("abc")
    expect(response.headers.get("content-security-policy")).toMatch(/script-src 'sha256-/)
  })
})
