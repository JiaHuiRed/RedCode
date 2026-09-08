import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "@/config/config"
import { Effect } from "effect"
import { UI } from "./ui"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: redcode.local)",
    default: "redcode.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}
// 260824 cc 回环判定：0.0.0.0 与 :: 是通配（等于对整个局域网开放），具体的内网 IP 同理。
// 只有这四个字面量才是"只有本机连得上"。
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

// 260908 Red 局域网监听的缺省密码。源码是公开的，这个值挡的是同网段顺手蹭，
// 不是定向攻击；真要私有就在环境变量里覆盖 REDCODE_SERVER_PASSWORD。
// 显式置空串视为"我知道我要关鉴权"，仍走下面的拒绝启动路径。
const LAN_DEFAULT_PASSWORD = "RedCode0429"

/**
 * 局域网暴露的密码闸门。
 *
 * 260824 cc 此前 serve/web 两条命令在没有 REDCODE_SERVER_PASSWORD 时只打印一行 warning
 * 然后照常监听 —— 而 `redcode web` 的整个用途就是把机器开给局域网，于是同一个 Wi-Fi 下的
 * 任何设备都能拿到 shell 与全部源码，一行灰字提示挡不住任何人。
 *
 * 260908 Red "没设密码就拒绝启动"收紧为"没设密码就落到 LAN_DEFAULT_PASSWORD 兜底"
 * （见 resolveLanDefaultPassword）：每次开 0.0.0.0 都要手工设环境变量太劝退，而内置一个
 * 默认密码比裸奔强。gate 保留给显式置空串的场景。这里必须运行期读 process.env 而不是
 * Flag —— Flag 是模块加载时的快照，兜底注入发生在命令执行期，读快照永远看不见。
 */
function assertPasswordForExposure(hostname: string) {
  if (LOOPBACK.has(hostname)) return
  if (process.env["REDCODE_SERVER_PASSWORD"]) return
  UI.error(`拒绝在 ${hostname} 上监听：REDCODE_SERVER_PASSWORD 未设或被显式置空。`)
  UI.println("")
  UI.println("  这个地址对局域网可见，同一网络下的任何设备都能拿到本机 shell 与全部源码。")
  UI.println("  设一个密码再启动（置空串 = 明确拒绝在此地址监听）：")
  UI.println("")
  UI.println('    PowerShell:  $env:REDCODE_SERVER_PASSWORD = "你的密码"')
  UI.println('    bash:        export REDCODE_SERVER_PASSWORD="你的密码"')
  UI.println("")
  UI.println("  只在本机用则不受影响：去掉 --hostname/--mdns，或显式指定 --hostname 127.0.0.1。")
  process.exit(1)
}

// 260908 Red 只对非回环绑定兜底：回环用法（本地脚本、SDK 直连 localhost）保持无鉴权，
// 测试与桌面 sidecar（自带随机密码 env）都不经过这条路径。
function resolveLanDefaultPassword(hostname: string) {
  if (LOOPBACK.has(hostname)) return
  if (process.env["REDCODE_SERVER_PASSWORD"] !== undefined) return
  process.env["REDCODE_SERVER_PASSWORD"] = LAN_DEFAULT_PASSWORD
}

export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  const opts = resolveNetworkOptionsNoConfig(args, config)
  resolveLanDefaultPassword(opts.hostname)
  assertPasswordForExposure(opts.hostname)
  return opts
})

export function resolveNetworkOptionsNoConfig(args: NetworkOptions, config?: Config.Info) {
  const portExplicitlySet = process.argv.includes("--port")
  const hostnameExplicitlySet = process.argv.includes("--hostname")
  const mdnsExplicitlySet = process.argv.includes("--mdns")
  const mdnsDomainExplicitlySet = process.argv.includes("--mdns-domain")
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  return { hostname, port, mdns, mdnsDomain, cors }
}
