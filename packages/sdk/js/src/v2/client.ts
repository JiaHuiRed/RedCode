export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "../error-interceptor.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-redcode-directory", "directory"],
    ["x-redcode-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value)
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-redcode-directory")
  next.headers.delete("x-redcode-workspace")
  return next
}

// 261006 Red 与 app 侧 server-health 的 timeoutSignal 同款兜底：AbortSignal.timeout
// 不可用时退化为 controller+setTimeout，不因运行时缺位直接炸。
function requestTimeoutSignal(ms: number) {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (typeof timeout === "function") {
    try {
      // 防 polyfill 对同款调用行为不一致；退化兜底语义不变
      return timeout.call(AbortSignal, ms)
    } catch {}
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

export function createOpencodeClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  const transport = config?.fetch ?? globalThis.fetch
  const clientSignal = config?.signal
  config = {
    ...config,
    fetch: Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request && !init ? input : new Request(input, init)
      // SSE 长连接端点（/global/event、/event）：不设超时，靠 signal 断开。
      if (new URL(request.url).pathname.endsWith("/event")) {
        return transport(Object.assign(request, { timeout: false }))
      }
      // 261006 Red 调用方经 config.signal 显式给了 signal：身份透传，超时归调用方管
      // （server-health 30s、SSE 不设，都是显式生命周期）；只有无人管生命周期的请求
      // 才套 60s 兜底。此前 261002 无条件 AbortSignal.any 合成新 signal，丢调用方身份，
      // 且裸调 AbortSignal.timeout 在缺位运行时直接 TypeError。
      if (clientSignal && request.signal === clientSignal) return transport(request)
      return transport(new Request(request, { signal: requestTimeoutSignal(60_000) }))
    }, transport),
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-redcode-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-redcode-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of RedCode Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new OpencodeClient({ client })
}
