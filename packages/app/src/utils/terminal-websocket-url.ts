import { authTokenFromCredentials } from "@/utils/server"

// 261017 Red 取连接票据失败时的分类。终端是"先有 PTY 进程、再取票据连 WebSocket"，
// 票据请求失败只说明这条通道没连上，PTY 里的编译/训练任务可能还在跑：
//   - 网络错误、超时、5xx → 可重试，保留原 id 与缓冲继续退避重连
//   - 403 → origin/CSRF 或 CORS 配置错误，重试一万次也一样，直接报给用户
export class TerminalTicketError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

export function ticketStatusError(status: number) {
  if (status === 403)
    return new TerminalTicketError(
      "PTY connect ticket rejected by origin or CSRF checks. Check the server CORS config.",
      false,
    )
  return new TerminalTicketError(`PTY connect ticket failed with ${status}`, true)
}

/** 非 HTTP 结果的异常（fetch 网络错误、超时）一律按可重试处理。 */
export function isRetryableTicketError(error: unknown) {
  if (error instanceof TerminalTicketError) return error.retryable
  return true
}

export function terminalWebSocketURL(input: {
  url: string
  id: string
  directory: string
  cursor: number
  ticket?: string
  sameOrigin?: boolean
  username?: string
  password?: string
  authToken?: boolean
}) {
  const next = new URL(`${input.url}/pty/${input.id}/connect`)
  next.searchParams.set("directory", input.directory)
  next.searchParams.set("cursor", String(input.cursor))
  next.protocol = next.protocol === "https:" ? "wss:" : "ws:"
  if (input.ticket) {
    next.searchParams.set("ticket", input.ticket)
    return next
  }
  if (input.password && (!input.sameOrigin || input.authToken))
    next.searchParams.set(
      "auth_token",
      authTokenFromCredentials({ username: input.username, password: input.password }),
    )
  return next
}
