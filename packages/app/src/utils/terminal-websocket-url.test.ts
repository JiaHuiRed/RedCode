import { describe, expect, test } from "bun:test"
import { isRetryableTicketError, terminalWebSocketURL, ticketStatusError } from "./terminal-websocket-url"

describe("terminalWebSocketURL", () => {
  test("uses query auth without embedding credentials in websocket URL", () => {
    const url = terminalWebSocketURL({
      url: "http://127.0.0.1:49365",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 0,
      sameOrigin: false,
      username: "redcode",
      password: "secret",
    })

    expect(url.protocol).toBe("ws:")
    expect(url.username).toBe("")
    expect(url.password).toBe("")
    expect(url.searchParams.get("auth_token")).toBe(btoa("redcode:secret"))
  })

  test("omits query auth for same-origin saved credentials", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      sameOrigin: true,
      username: "redcode",
      password: "secret",
    })

    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("uses query auth for same-origin credentials from auth_token", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      sameOrigin: true,
      username: "redcode",
      password: "secret",
      authToken: true,
    })

    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.get("auth_token")).toBe(btoa("redcode:secret"))
  })
})

// 261017 Red 回归：票据失败要保留原终端。只有 403 属于配置错误，其余都该重连。
describe("isRetryableTicketError", () => {
  test("retries transient failures so the existing PTY survives", () => {
    expect(isRetryableTicketError(ticketStatusError(500))).toBe(true)
    expect(isRetryableTicketError(ticketStatusError(502))).toBe(true)
    expect(isRetryableTicketError(new TypeError("fetch failed"))).toBe(true)
  })

  test("does not retry a rejected origin or CSRF check", () => {
    expect(isRetryableTicketError(ticketStatusError(403))).toBe(false)
  })

  test("keeps the underlying message for the user", () => {
    expect(ticketStatusError(403).message).toContain("origin or CSRF")
    expect(ticketStatusError(503).message).toContain("503")
  })
})
