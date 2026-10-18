import { Agent, ProxyAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici"
import * as Log from "@redcode-ai/core/util/log"
import { proxyFromEnv, shouldProxy, originOf } from "./proxy"

// 261018 Red 路由谓词已移到 proxy.ts（Bun 侧 per-request proxy 与 Node 侧 dispatcher
// 必须共用同一个判据）；这里保留同名导出，既有调用方与测试不用改导入路径。
export { shouldProxy }

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
 * - **不动 Bun 的 dispatcher**（它不读 undici 的全局 dispatcher）。但 Bun 侧另有自己的坑：
 *   `fetch` 只认**进程启动瞬间**的 `HTTP(S)_PROXY`，而 Windows 系统代理是启动后才从
 *   WinINET 解析出来的——于是 Bun 这条路原先整条裸连（GUI 走 Chromium 网络栈反而不受影响）。
 *   修法见下面的 Bun 分支：按请求注入 `init.proxy`，与 `fetchWithProxy()` 同一形态。
 *
 * **loopback 恒绕过**是硬性要求，不是优化：GUI 与 sidecar 之间、Ollama 这类本地
 * provider、以及全部本地测试服务器都在 loopback 上，代理它们会形成回环。
 * `models-dev.ts` 当初不做全局代理的顾虑（「会把 Ollama 的请求也一起代理掉」）
 * 就是被这一条解掉的。
 */

/** 已安装的策略；重复调用是幂等的。 */
let installed: { proxy: string; previous: Dispatcher } | undefined
/** Bun 侧装的是 fetch 包装而不是 dispatcher，单独记一份以便卸载。 */
let installedBunFetch: { previous: typeof fetch } | undefined

/**
 * 装上全局代理策略：Node 下换全局 dispatcher，Bun 下包装 `globalThis.fetch`。
 * 没有解析到代理时不装。返回卸载函数，测试用。
 */
export function installGlobalProxy(): (() => void) | undefined {
  if (installed || installedBunFetch) return undefined

  const proxy = proxyFromEnv()
  if (!proxy) return undefined

  if (typeof Bun !== "undefined") {
    // 261018 Red Bun 没有全局 dispatcher，也没有「运行期重新读 env」的通道；包装 fetch
    // 并在路由命中时注入 init.proxy 是唯一能一次覆盖全部调用点（webfetch / web 搜索 /
    // 插件 / HTTP MCP）的形态。判据仍走 shouldProxy，loopback 与 NO_PROXY 照旧直连。
    const previous = globalThis.fetch
    const patched = ((input: RequestInfo | URL, init?: RequestInit) =>
      shouldProxy(originOf(input))
        ? previous(input, { ...init, proxy } as RequestInit & { proxy: string })
        : previous(input, init)) as typeof fetch
    globalThis.fetch = patched
    installedBunFetch = { previous }
    log.info("global proxy installed", { runtime: "bun", proxy: proxy.replace(/\/\/[^@]*@/, "//***@") })

    return () => {
      if (!installedBunFetch) return
      globalThis.fetch = installedBunFetch.previous
      installedBunFetch = undefined
    }
  }

  const previous = getGlobalDispatcher()
  // 按 origin 决定去向：走代理的给 ProxyAgent，绕过的给 undici 默认客户端。
  // 判据与 shouldProxy 同源——两者一旦分歧，就会出现「dispatcher 隧道转发、
  // 而调用方以为直连」这类查不出来的现象。
  const agent = new Agent({
    factory: (origin, opts) =>
      shouldProxy(String(origin)) ? new ProxyAgent({ ...opts, uri: proxy }) : new Agent(opts),
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
