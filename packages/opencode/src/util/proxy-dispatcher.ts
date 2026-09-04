import { Agent, ProxyAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici"
import * as Log from "@redcode-ai/core/util/log"
import { proxyFromEnv } from "./proxy"

const log = Log.create({ service: "proxy" })

/**
 * 一份出站代理策略，在任何请求发生之前装成全局 dispatcher。
 *
 * 260903 cc 起因：**Node 内置的 `fetch` 完全忽略 `HTTP_PROXY` / `HTTPS_PROXY`**。
 * curl、git、npm、pip 都听，Node 的 fetch 不听——用户导出一次变量就期待全都生效，
 * sidecar 偏偏不。此前本仓是「按调用点逐个改」：`fetchWithProxy()` 只有两个消费者
 * （`provider.ts`、`plugin/codex.ts`），而服务端有二十个文件在直接 `fetch(`，
 * 于是 webfetch、web 搜索、HTTP MCP、各家插件、更新检查在 GUI 那条路上全是直连——
 * 尽管 `desktop/server.ts` 早就把系统代理注进了 sidecar 的 env（那一注只救得了
 * npm / MCP 这些**子进程**，救不了 sidecar 自己的 fetch）。
 *
 * `models-dev.ts` 的注释把这件事写明过：「Bun 的 fetch 认 init.proxy，**Node 的会忽略
 * 未知字段（等于不生效）**」。本模块补的就是 Node 这一侧。
 *
 * 设计取自 deepseek-harness 的 `2026-08-27-outbound-proxy-policy`（他们为此付出 1 个
 * feat + 11 个 fix 的代价，坑都写在那篇 note 里），但**只取形态不取实现**：
 *
 * - **不用 `EnvHttpProxyAgent`**。它在没有 `HTTPS_PROXY` 时会把 HTTPS agent 设成 HTTP
 *   agent，于是本该保持直连的 scheme 仍被隧道转发，而诊断还声称直连。这里让
 *   `shouldProxy()` 与 dispatcher 走同一个谓词，从构造上消除分歧。
 * - **不碰 `NODE_USE_ENV_PROXY`**。它会让 `HTTP_PROXY` 是非 http(s) 协议时，每个 Node
 *   子进程在第一行之前就以 1 退出（上游在 Node 24.17 实测 `socks4://` / `ftp://` /
 *   畸形值均如此）——而本机 git 对 github 用的正是 `socks5h://`。子进程那层由
 *   `desktop/server.ts` 注 env 管，本模块不介入。
 * - **不动 Bun**。TUI 走 Bun，其 fetch 原生认代理环境变量；undici 的全局 dispatcher
 *   也不是 Bun fetch 会读的东西，装了等于空转。
 *
 * **loopback 恒绕过**是硬性要求，不是优化：GUI 与 sidecar 之间、Ollama 这类本地
 * provider、以及全部本地测试服务器都在 loopback 上，代理它们会形成回环。
 * `models-dev.ts` 当初不做全局代理的顾虑（「会把 Ollama 的请求也一起代理掉」）
 * 就是被这一条解掉的。
 */

/** 已安装的策略；重复调用是幂等的。 */
let installed: { proxy: string; previous: Dispatcher } | undefined

/**
 * 解析 NO_PROXY。支持后缀匹配（`.example.com` 与 `example.com` 等价）、
 * 通配前缀（`192.168.*`）、`host:port`，以及 `*` 表示全部绕过。
 */
function parseNoProxy(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * loopback 判定。**同时认 `::1` 与 `[::1]`**：undici 自带的匹配器会把裸写的 `::1`
 * 读成「主机 `:` 端口 `1`」，从而永不豁免它（上游踩过）。这里自己判，不依赖它。
 */
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

/** 某个 origin 该不该走代理。dispatcher 与任何调用方都必须问这一个函数。 */
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

/**
 * 装上全局 dispatcher。Bun 下是空操作；没有解析到代理时不装。
 * 返回卸载函数（还原上一个 dispatcher），测试用。
 */
export function installGlobalProxy(): (() => void) | undefined {
  if (typeof Bun !== "undefined") return undefined
  if (installed) return undefined

  const proxy = proxyFromEnv()
  if (!proxy) return undefined

  const previous = getGlobalDispatcher()
  // 按 origin 决定去向：走代理的给 ProxyAgent，绕过的给 undici 默认客户端。
  // 判据与 shouldProxy 同源——两者一旦分歧，就会出现「dispatcher 隧道转发、
  // 而调用方以为直连」这类查不出来的现象。
  const agent = new Agent({
    factory: (origin, opts) => (shouldProxy(String(origin)) ? new ProxyAgent({ ...opts, uri: proxy }) : new Agent(opts)),
  })
  setGlobalDispatcher(agent)
  installed = { proxy, previous }
  log.info("global proxy installed", {
    proxy: proxy.replace(/\/\/[^@]*@/, "//***@"),
    noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? "",
  })

  return () => {
    if (!installed) return
    setGlobalDispatcher(installed.previous)
    // close 而非 destroy：策略被卸载时已经发出的请求仍会跑完
    void agent.close().catch(() => {})
    installed = undefined
  }
}
