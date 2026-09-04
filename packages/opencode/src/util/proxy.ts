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
// 260902 Red 修正：flags 只是信息位而非硬判据——Clash Verge PAC 模式下
// flags=0x464（0x4=AUTO_PROXY_URL）且不含 0x2（PROXY_TYPE），此时老实现
// 直接返回 undefined；权威开关在 offset 8 的 proxyEnable，proxyServer 字段
// 按长度字段(offset 12)解析，与 flags 值无关。
export function parseDefaultConnectionSettings(hex: string): string | undefined {
  const bytes = Buffer.from(hex, "hex")
  if (bytes.length < 20) return undefined
  if (bytes.readUInt32LE(8) !== 1) return undefined
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
function windowsSystemProxy(): string | undefined {
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

let proxyAgent: ProxyAgent | undefined

// Node 原生 fetch 不接受 dispatcher；undici fetch 与运行时同构，只在这里对齐类型。
const undiciFetchTyped = undiciFetch as unknown as (
  url: RequestInfo | URL,
  init?: RequestInit & { dispatcher?: ProxyAgent },
) => Promise<Response>

export function fetchWithProxy(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const proxy = proxyFromEnv()
  if (!proxy || typeof Bun !== "undefined") return fetch(url, init)
  if (!proxyAgent) proxyAgent = new ProxyAgent(proxy)
  return undiciFetchTyped(url, { ...init, dispatcher: proxyAgent })
}
