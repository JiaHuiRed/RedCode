import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

// 261116 Red A05 桌面浏览器预览桥：
//   桌面端没有可用的「文件 URL → 默认浏览器」路径（Blob URL 出不了渲染进程，openPath 不保证
//   走浏览器，远程路径不在本机），所以只把**已经包进沙箱 iframe 的 HTML 文档**经回环 HTTP
//   交给系统浏览器：随机 token 路径、只读、无文件系统/工作区入口、不收写入。
//   BLOB/下载冒充都不算打开浏览器，这条才是真实的独立来源（CSP sandbox = opaque origin）。
//   决策：docs/notes/implemented/feature/2026-11-16-experience-roadmap-v2.md
const HOST = "127.0.0.1"
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
const MAX_CACHE_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 8
const ENTRY_TTL_MS = 10 * 60 * 1000

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // 单次预览，不留 keep-alive 连接：close() 不会被空闲 socket 拖住
  Connection: "close",
} as const

type PreviewEntry = { html: string; bytes: number; createdAt: number }
type PreviewDeps = { openExternal(url: string): void | Promise<unknown> }

const entries = new Map<string, PreviewEntry>()
let cachedBytes = 0
let server: Server | undefined
let listening: Promise<number> | undefined

export async function openHtmlPreview(document: string, deps: PreviewDeps) {
  prune()
  const bytes = Buffer.byteLength(document, "utf8")
  if (bytes > MAX_DOCUMENT_BYTES)
    throw new Error(`HTML preview document too large: ${bytes} bytes exceeds the ${MAX_DOCUMENT_BYTES} byte limit`)

  const token = randomBytes(24).toString("base64url")
  entries.set(token, { html: document, bytes, createdAt: Date.now() })
  cachedBytes += bytes
  prune(token)

  const port = await listen()
  await deps.openExternal(`http://${HOST}:${port}/${token}`)
}

export async function closeBrowserPreview() {
  entries.clear()
  cachedBytes = 0
  const current = server
  server = undefined
  listening = undefined
  if (!current) return
  await new Promise<void>((resolve) => {
    current.close(() => resolve())
    current.closeAllConnections?.()
  })
}

function listen() {
  if (listening) return listening
  const created = createServer(handleRequest)
  server = created
  const next = new Promise<number>((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) {
        // 261116 Red 监听成功后的 socket 级异常：不静默，也不能让未监听的 error 事件抛崩主进程
        console.error("[browser-preview] server error", error)
        return
      }
      settled = true
      created.off("listening", ready)
      if (server === created) server = undefined
      listening = undefined
      reject(error)
    }
    const ready = () => {
      const address = created.address()
      if (!address || typeof address === "string") {
        fail(new Error("HTML preview server failed to acquire a loopback port"))
        return
      }
      settled = true
      created.unref()
      resolve(address.port)
    }
    // 永久挂载：监听期间的失败走 fail()，成功后的异常只记日志（error 事件无监听会抛）
    created.on("error", fail)
    created.once("listening", ready)
    created.listen(0, HOST)
  })
  listening = next
  return next
}

function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const token = tokenFromURL(request.url)
  const entry = token ? entries.get(token) : undefined
  if (!token || !entry) {
    deny(response, 404, "Not Found")
    return
  }
  if (Date.now() - entry.createdAt >= ENTRY_TTL_MS) {
    remove(token)
    deny(response, 404, "Not Found")
    return
  }

  const method = request.method ?? "GET"
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { ...COMMON_HEADERS, Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" })
    response.end("Method Not Allowed")
    return
  }

  response.writeHead(200, {
    ...COMMON_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(entry.bytes),
    // 顶层文档也强制沙箱：真实独立（不透明）来源，且不再给 allow-same-origin
    "Content-Security-Policy": "sandbox allow-scripts",
  })
  if (method === "HEAD") {
    response.end()
    return
  }
  response.end(entry.html)
}

function tokenFromURL(requestURL: string | undefined) {
  if (!requestURL) return
  const path = requestURL.split("?")[0]?.split("#")[0] ?? ""
  if (!path.startsWith("/")) return
  const token = path.slice(1)
  if (!token || token.includes("/")) return
  return token
}

function deny(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, {
    ...COMMON_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
  })
  response.end(body)
}

function remove(token: string) {
  const entry = entries.get(token)
  if (!entry) return
  cachedBytes -= entry.bytes
  entries.delete(token)
}

// 惰性回收：只在发布新预览时结算 TTL 与容量（不注册定时器，不占事件循环）
function prune(keep?: string) {
  const now = Date.now()
  for (const [token, entry] of entries) {
    if (token === keep) continue
    if (now - entry.createdAt >= ENTRY_TTL_MS) remove(token)
  }
  while (entries.size > MAX_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
    const oldest = oldestToken(keep)
    if (!oldest) break
    remove(oldest)
  }
}

function oldestToken(keep?: string) {
  let result: string | undefined
  let createdAt = Number.POSITIVE_INFINITY
  for (const [token, entry] of entries) {
    if (token === keep) continue
    if (entry.createdAt >= createdAt) continue
    result = token
    createdAt = entry.createdAt
  }
  return result
}
