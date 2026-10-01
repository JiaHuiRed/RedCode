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
