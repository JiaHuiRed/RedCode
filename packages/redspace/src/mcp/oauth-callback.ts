import { createConnection } from "net"
import { createServer } from "http"
import { createHash } from "node:crypto"
import * as Log from "@redcode-ai/core/util/log"
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH, parseRedirectUri } from "./oauth-provider"

const log = Log.create({ service: "mcp.oauth-callback" })

// Current callback server configuration (may differ from defaults if custom redirectUri is used)
let currentPort = OAUTH_CALLBACK_PORT
let currentPath = OAUTH_CALLBACK_PATH

// 261017 Red 成功页自动关窗；CSP 用它的 hash 单独放行这一条内联脚本。
const SUCCESS_SCRIPT = "setTimeout(() => window.close(), 2000)"

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>RedCode - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to RedCode.</p>
  </div>
  <script>${SUCCESS_SCRIPT}</script>
</body>
</html>`

// 261017 Red 回调页只渲染固定骨架，错误文本经过转义；CSP 是第二道防线：
// 错误页完全禁用脚本，成功页只放行下面这段固定 script 的 hash。
const ERROR_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
const SUCCESS_CSP = `${ERROR_CSP}; script-src 'sha256-${createHash("sha256").update(SUCCESS_SCRIPT).digest("base64")}'`

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>RedCode - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${escapeHtml(error)}</div>
  </div>
</body>
</html>`

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let server: ReturnType<typeof createServer> | undefined
const pendingAuths = new Map<string, PendingAuth>()
// Reverse index: mcpName → oauthState, so cancelPending(mcpName) can
// find the right entry in pendingAuths (which is keyed by oauthState).
const mcpNameToState = new Map<string, string>()

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

function cleanupStateIndex(oauthState: string) {
  for (const [name, state] of mcpNameToState) {
    if (state === oauthState) {
      mcpNameToState.delete(name)
      break
    }
  }
}

function respond(res: import("http").ServerResponse, status: number, body: string, csp: string) {
  res.writeHead(status, { "Content-Type": "text/html", "Content-Security-Policy": csp })
  res.end(body)
}

function handleRequest(req: import("http").IncomingMessage, res: import("http").ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${currentPort}`)

  if (url.pathname !== currentPath) {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  log.info("received oauth callback", { hasCode: !!code, state, error })

  if (!state) {
    log.error("oauth callback missing state parameter", { url: url.toString() })
    respond(res, 400, HTML_ERROR("Missing required state parameter - potential CSRF attack"), ERROR_CSP)
    return
  }

  // 261017 Red state 校验前移到所有分支之前。旧实现只要求 state 非空，错误分支于是能用
  // 任意 state 拿到 200 并渲染页面——等于给外部可控的错误文本开了一个不需要授权流程
  // 在途的入口。现在无效 state 一律 400，错误文本只在真正 pending 时展示。
  if (!pendingAuths.has(state)) {
    log.error("oauth callback with invalid state", { state, pendingStates: Array.from(pendingAuths.keys()) })
    respond(res, 400, HTML_ERROR("Invalid or expired state parameter - potential CSRF attack"), ERROR_CSP)
    return
  }

  if (error) {
    const errorMsg = errorDescription || error
    const pending = pendingAuths.get(state)!
    clearTimeout(pending.timeout)
    pendingAuths.delete(state)
    cleanupStateIndex(state)
    pending.reject(new Error(errorMsg))
    respond(res, 200, HTML_ERROR(errorMsg), ERROR_CSP)
    return
  }

  if (!code) {
    respond(res, 400, HTML_ERROR("No authorization code provided"), ERROR_CSP)
    return
  }

  const pending = pendingAuths.get(state)!
  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  cleanupStateIndex(state)
  pending.resolve(code)

  respond(res, 200, HTML_SUCCESS, SUCCESS_CSP)
}

export async function ensureRunning(redirectUri?: string): Promise<void> {
  // Parse the redirect URI to get port and path (uses defaults if not provided)
  const { port, path } = parseRedirectUri(redirectUri)

  // If server is running on a different port/path, stop it first
  if (server && (currentPort !== port || currentPath !== path)) {
    log.info("stopping oauth callback server to reconfigure", { oldPort: currentPort, newPort: port })
    await stop()
  }

  if (server) return

  const running = await isPortInUse(port)
  if (running) {
    log.info("oauth callback server already running on another instance", { port })
    return
  }

  currentPort = port
  currentPath = path

  server = createServer(handleRequest)
  await new Promise<void>((resolve, reject) => {
    // 260624 Red 上游 bugfix: 显式绑定 IPv4 回环地址，防止监听所有接口
    server!.listen(currentPort, "127.0.0.1", () => {
      log.info("oauth callback server started", { port: currentPort, path: currentPath })
      resolve()
    })
    server!.on("error", reject)
  })
}

export function waitForCallback(oauthState: string, mcpName?: string): Promise<string> {
 if (mcpName) mcpNameToState.set(mcpName, oauthState)
 const promise = new Promise<string>((resolve, reject) => {
   const timeout = setTimeout(() => {
     if (pendingAuths.has(oauthState)) {
       pendingAuths.delete(oauthState)
       if (mcpName) mcpNameToState.delete(mcpName)
       reject(new Error("OAuth callback timeout - authorization took too long"))
     }
   }, CALLBACK_TIMEOUT_MS)

   pendingAuths.set(oauthState, { resolve, reject, timeout })
 })
 // 260930 Red 调用方可能在 await 前被中断（连接取消/实例销毁），此时超时、
 // stop() 或 cancelPending 的 reject 无人消费，会以 unhandledRejection 杀死
 // 整个 sidecar（260930 实证 crash）。预挂空 catch 兜底；真正的 await 仍能
 // 收到原始 rejection。
  promise.catch(() => {})
 return promise
}

export function cancelPending(mcpName: string): void {
  // Look up the oauthState for this mcpName via the reverse index
  const oauthState = mcpNameToState.get(mcpName)
  const key = oauthState ?? mcpName
  const pending = pendingAuths.get(key)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingAuths.delete(key)
    mcpNameToState.delete(mcpName)
    pending.reject(new Error("Authorization cancelled"))
  }
}

export async function isPortInUse(port: number = OAUTH_CALLBACK_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => {
      resolve(false)
    })
  })
}

export async function stop(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    log.info("oauth callback server stopped")
  }

  for (const [_name, pending] of pendingAuths) {
    clearTimeout(pending.timeout)
    pending.reject(new Error("OAuth callback server stopped"))
  }
  pendingAuths.clear()
  mcpNameToState.clear()
}

export function isRunning(): boolean {
  return server !== undefined
}

export * as McpOAuthCallback from "./oauth-callback"
