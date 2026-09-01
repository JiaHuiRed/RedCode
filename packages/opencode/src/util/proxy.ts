import { execFileSync } from "node:child_process"
import { ProxyAgent, fetch as undiciFetch } from "undici"

function proxyFromEnv(): string | undefined {
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    const value = process.env[name]?.trim()
    if (value && /^https?:\/\//.test(value)) return value
  }
  if (process.platform === "win32") return windowsSystemProxy()
  return undefined
}

// 260901 Red Windows 系统代理存于 WinINET 的 DefaultConnectionSettings blob，
// 需要转成 HTTP(S)_PROXY 才能让 Bun/Node 的出站请求使用它。
export function parseDefaultConnectionSettings(hex: string): string | undefined {
  const bytes = Buffer.from(hex, "hex")
  if (bytes.length < 8) return undefined
  const flags = bytes.readUInt32LE(4)
  if ((flags & 0x2) === 0) return undefined
  const host = bytes.toString("latin1").match(/[a-zA-Z0-9.-]+:\d{2,5}/)?.[0]
  return host ? `http://${host}` : undefined
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
