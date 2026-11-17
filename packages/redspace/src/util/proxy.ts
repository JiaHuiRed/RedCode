import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { ProxyAgent, fetch as undiciFetch } from "undici"

export function proxyFromEnv(): string | undefined {
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    const value = process.env[name]?.trim()
    if (value && /^https?:\/\//.test(value)) return value
  }
  if (process.platform === "win32") return windowsSystemProxy()
  return undefined
}

// 260901 Red Windows 系统代理存于 WinINET 的 DefaultConnectionSettings blob，
// 需要转成 HTTP(S)_PROXY 才能让 Bun/Node 的出站请求使用它。
// 260902 Red 修正：flags 只是信息位而非硬判据——PAC 模式下 flags 含 0x4
// （AUTO_PROXY_URL）而不含 0x2（PROXY_TYPE），不能因缺 0x2 就放弃解析。
// 261014 Red 再修正：offset 8 就是 INTERNET_PER_CONN_FLAGS 位域本身，不是什么布尔
// proxyEnable——WinINET API 实测（InternetQueryOption）与写入方 RedClash
// （sysproxy-rs/src/windows.rs set() 写 PROXY_TYPE_PROXY|PROXY_TYPE_DIRECT）双向印证：
// 3=代理开着、1=仅 DIRECT（关）、5=PAC。旧判据 `!== 1` 把开着的代理（3）判成直连，
// 家里无 HTTPS_PROXY 环境变量时 provider fetch 全裸连、OpenAI 超时；公司因 env 分支
// 先命中而掩盖了这个 bug。TUN 能救场只是透明拦截了那些直连。
const PROXY_TYPE_PROXY = 0x2
const PROXY_TYPE_AUTO_PROXY_URL = 0x4

export function parseDefaultConnectionSettings(hex: string): string | undefined {
  const bytes = Buffer.from(hex, "hex")
  if (bytes.length < 20) return undefined
  // 只有 PROXY（0x2）或 PAC（0x4）有一位置起才算配了代理；纯 DIRECT（1）与
  // AUTO_DETECT（0x8，WPAD 本地解不出）都按直连处理。
  if ((bytes.readUInt32LE(8) & (PROXY_TYPE_PROXY | PROXY_TYPE_AUTO_PROXY_URL)) === 0) return undefined
  const proxyLen = bytes.readUInt32LE(12)
  const proxy = bytes.subarray(16, 16 + proxyLen).toString("latin1")
  const host = proxy.match(/^[a-zA-Z0-9.-]+:\d{2,5}$/)?.[0]
  return host ? `http://${host}` : pacProxyTarget(bytes)
}

// 260902 Red PAC-only 兜底：proxyServer 字段为空时（WinINET「使用安装脚本」模式），
// 读 blob 尾部的 file:// PAC，取第一个 PROXY host:port（本机 PAC 白名单都指向同一代理）。
// URI 网页版 PAC 无法在本地执行 JS，返回 undefined（与 Electron 行为差异，GUI 仍可走 Chromium）。
function pacProxyTarget(bytes: Buffer): string | undefined {
  const proxyLen = bytes.readUInt32LE(12)
  const bypassLen = bytes.readUInt32LE(16 + proxyLen)
  const pacOffset = 16 + proxyLen + 4 + bypassLen + 4
  if (bytes.length < pacOffset) return undefined
  const pacLen = bytes.readUInt32LE(pacOffset - 4)
  if (bytes.length < pacOffset + pacLen) return undefined
  const pacUrl = bytes.subarray(pacOffset, pacOffset + pacLen).toString("latin1")
  if (!pacUrl.startsWith("file:///")) return undefined
  try {
    const pacPath = decodeURIComponent(pacUrl.slice("file:///".length)).replace(/\//g, "\\")
    const pac = readFileSync(pacPath, "utf8")
    const host = pac.match(/PROXY\s+([a-zA-Z0-9.-]+:\d{2,5})/)?.[1]
    return host ? `http://${host}` : undefined
  } catch {
    return undefined
  }
}
// 261018 Red 解析结果缓存：windowsSystemProxy 每次调用都要 spawn 一个 reg.exe。
// Node 侧只在启动时装一次全局 dispatcher，Bun 侧却是**每个请求**问一次代理，
// 不缓存就是每个 LLM 请求外加一次子进程（实测 ~40ms）。未命中同样缓存——与
// Node 侧一致，代理开关的变更在重启后生效。
let cachedSystemProxy: { value: string | undefined } | undefined

function windowsSystemProxy(): string | undefined {
  if (cachedSystemProxy) return cachedSystemProxy.value
  const url = readWindowsSystemProxy()
  cachedSystemProxy = { value: url }
  return url
}

function readWindowsSystemProxy(): string | undefined {
  try {
    const result = execFileSync(
      "reg.exe",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections",
        "/v",
        "DefaultConnectionSettings",
      ],
      { encoding: "utf8", timeout: 5000 },
    )
    const hex = /REG_BINARY\s+([0-9a-fA-F]+)/.exec(result)?.[1]
    const url = hex ? parseDefaultConnectionSettings(hex) : undefined
    if (url) {
      process.env.HTTPS_PROXY = url
      process.env.HTTP_PROXY = url
    }
    return url
  } catch {
    // 260901 Red reg.exe 缺失、超时或没有系统代理时保持直连。
    return undefined
  }
}

/** 解析 NO_PROXY。支持后缀匹配（`.example.com` 与 `example.com` 等价）、通配前缀（`192.168.*`）、`host:port`，以及 `*` 表示全部绕过。 */
function parseNoProxy(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

/** loopback 判定。**同时认 `::1` 与 `[::1]`**：undici 自带的匹配器会把裸写的 `::1` 读成「主机 `:` 端口 `1`」，从而永不豁免它（上游踩过）。 */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true
  // 127.0.0.0/8 整段，不只是 127.0.0.1
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (host === "0.0.0.0") return true
  return false
}

function matchesNoProxy(hostname: string, port: string, entries: string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  for (const entry of entries) {
    if (entry === "*") return true
    const [rawHost, rawPort] = entry.includes(":") && !entry.includes("::") ? entry.split(":") : [entry, undefined]
    if (rawPort && rawPort !== port) continue
    const target = (rawHost ?? "").replace(/^\[|\]$/g, "")
    if (!target) continue
    if (target.endsWith("*")) {
      if (host.startsWith(target.slice(0, -1))) return true
      continue
    }
    const bare = target.startsWith(".") ? target.slice(1) : target
    if (host === bare || host.endsWith("." + bare)) return true
  }
  return false
}

/**
 * 某个 origin 该不该走代理。dispatcher、Bun 的 per-request `proxy` 与任何调用方都必须问这一个函数
 * —— 三者一旦分歧，就会出现「隧道转发、而调用方以为直连」这类查不出来的现象。
 *
 * 261018 Red 从 proxy-dispatcher.ts 移到这里：Bun 侧（TUI）也要用同一个谓词，
 * 而 dispatcher 依赖本模块的 proxyFromEnv，放原处会造成循环导入。
 */
export function shouldProxy(origin: string | URL, noProxy = process.env.NO_PROXY ?? process.env.no_proxy): boolean {
  let url: URL
  try {
    url = typeof origin === "string" ? new URL(origin) : origin
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  if (isLoopback(url.hostname)) return false
  return !matchesNoProxy(url.hostname, url.port, parseNoProxy(noProxy))
}

// fetch 的第一个参数可能是 Request 对象（AI SDK 会这么传），取它的 url 判路由。
export function originOf(input: RequestInfo | URL): string | URL {
  if (typeof input === "string") return input
  if (input instanceof URL) return input
  return input.url
}

let proxyAgent: ProxyAgent | undefined

// Node 原生 fetch 不接受 dispatcher；undici fetch 与运行时同构，只在这里对齐类型。
const undiciFetchTyped = undiciFetch as unknown as (
  url: RequestInfo | URL,
  init?: RequestInit & { dispatcher?: ProxyAgent },
) => Promise<Response>

export function fetchWithProxy(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const proxy = proxyFromEnv()
  if (!proxy || !shouldProxy(originOf(url))) return fetch(url, init)
  if (typeof Bun !== "undefined") {
    // 261018 Red Bun 只在**进程启动瞬间**快照 HTTP(S)_PROXY，运行期写 process.env 无效
    // （实测：无 env 启动 → 直连超时；启动后补写 → 仍超时）。而本机系统代理来自
    // WinINET 解析，必然发生在启动之后 —— 所以 Bun 这条路必须按请求显式传 proxy，
    // 不能像原实现那样指望 windowsSystemProxy() 写环境变量。这也是「GUI 能连、TUI 连不上」
    // 的直接原因：GUI 走 Electron/Chromium 网络栈读系统代理，TUI 走 Bun fetch 只认启动时 env。
    return fetch(url, { ...init, proxy } as RequestInit & { proxy: string })
  }
  if (!proxyAgent) proxyAgent = new ProxyAgent(proxy)
  return undiciFetchTyped(url, { ...init, dispatcher: proxyAgent })
}
