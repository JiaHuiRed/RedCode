import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "@/config/config"
import { Effect } from "effect"
import { Flag } from "@redcode-ai/core/flag/flag"
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

/**
 * 局域网暴露的密码闸门。
 *
 * 260824 cc 此前 serve/web 两条命令在没有 REDCODE_SERVER_PASSWORD 时只打印一行 warning
 * 然后照常监听 —— 而 `redcode web` 的整个用途就是把机器开给局域网，于是同一个 Wi-Fi 下的
 * 任何设备都能拿到 shell 与全部源码，一行灰字提示挡不住任何人。
 *
 * 这里选择**直接拒绝启动**而不是静默退回回环：`--hostname 0.0.0.0` 只有一个用途，
 * 悄悄改成只听本机等于把命令变成一个不做事的空壳，而用户会去查"为什么手机连不上"——
 * 那种排查最费时间。报错必须把下一步动作写清楚。
 */
function assertPasswordForExposure(hostname: string) {
  if (LOOPBACK.has(hostname)) return
  if (Flag.REDCODE_SERVER_PASSWORD) return
  UI.error(`拒绝在 ${hostname} 上监听：未设置 REDCODE_SERVER_PASSWORD。`)
  UI.println("")
  UI.println("  这个地址对局域网可见，同一网络下的任何设备都能拿到本机 shell 与全部源码。")
  UI.println("  设一个密码再启动：")
  UI.println("")
  UI.println('    PowerShell:  $env:REDCODE_SERVER_PASSWORD = "你的密码"')
  UI.println('    bash:        export REDCODE_SERVER_PASSWORD="你的密码"')
  UI.println("")
  UI.println("  只在本机用则不受影响：去掉 --hostname/--mdns，或显式指定 --hostname 127.0.0.1。")
  process.exit(1)
}

export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  const opts = resolveNetworkOptionsNoConfig(args, config)
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
