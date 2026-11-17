import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "@/config/config"
import { Effect } from "effect"
import { UI } from "./ui"
import { networkInterfaces } from "os"
import { randomBytes } from "node:crypto"

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

// 261017 Red 取消公开的固定默认密码：旧值写在公开源码里，等于所有默认实例共享同一个
// 凭据——知道它的人可以对任何开了局域网监听的机器创建 PTY 并执行命令，这已经不是
// 「同网段顺手蹭」的量级。现在改成每次启动随机生成并打印到 stderr，重启即换；
// 想固定就自己设 REDCODE_SERVER_PASSWORD。
// 显式置空串视为"我知道我要关鉴权"，仍走下面的拒绝启动路径。
function generateLanPassword() {
  return randomBytes(18).toString("base64url")
}

export function announceLanPassword(password: string) {
  UI.println("")
  UI.println(UI.Style.TEXT_WARNING_BOLD + "  局域网密码（本次启动随机生成）:", UI.Style.TEXT_NORMAL, password)
  UI.println("  其他设备连接时输入这个密码；重启后会更换。想固定密码请先设置 REDCODE_SERVER_PASSWORD。")
}

/**
 * 局域网暴露的密码闸门。
 *
 * 260824 cc 此前 serve/web 两条命令在没有 REDCODE_SERVER_PASSWORD 时只打印一行 warning
 * 然后照常监听 —— 而 `redcode web` 的整个用途就是把机器开给局域网，于是同一个 Wi-Fi 下的
 * 任何设备都能拿到 shell 与全部源码，一行灰字提示挡不住任何人。
 *
 * 261017 Red 兜底不再是写死的常量，而是随机生成并打印（见 resolveLanDefaultPassword）：
 * 每次开 0.0.0.0 都要手工设环境变量太劝退，而随机密码比裸奔强，也不存在共享凭据。
 * gate 保留给显式置空串的场景。这里必须运行期读 process.env 而不是
 * Flag —— Flag 是模块加载时的快照，兜底注入发生在命令执行期，读快照永远看不见。
 */
export function assertPasswordForExposure(hostname: string) {
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

// 261017 Red 只对非回环绑定兜底：回环用法（本地脚本、SDK 直连 localhost）保持无鉴权，
// 测试与桌面 sidecar（自带随机密码 env）都不经过这条路径。
// 返回值只在本次真正生成了密码时非空，调用方据此决定是否告知用户。
export function resolveLanDefaultPassword(hostname: string) {
  if (LOOPBACK.has(hostname)) return
  if (process.env["REDCODE_SERVER_PASSWORD"] !== undefined) return
  const password = generateLanPassword()
  process.env["REDCODE_SERVER_PASSWORD"] = password
  return password
}

export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  const opts = resolveNetworkOptionsNoConfig(args, config)
  const lanPassword = resolveLanDefaultPassword(opts.hostname)
  assertPasswordForExposure(opts.hostname)
  // 261017 Red 随机密码只存在于进程 env 里，不打出来用户就永远连不上——这是它取代固定
  // 默认密码的前提。UI.println 走 stderr，不会污染 acp 的 stdout 协议。
  if (lanPassword) announceLanPassword(lanPassword)
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

// 260913 Red web.ts 和 run.ts 原先各有一份同形状的网卡枚举，且都只跳过了 172.*。
// 那两份会把 link-local（169.254.x.x，手机不可达）和代理 TUN 常见的 RFC 2544 基准段
// （198.18/198.19）一起打给用户，照着敲一个连不上一个。统一到一处，也顺手消掉重复。
export function isUsableLanAddress(address: string) {
  return !(
    address.startsWith("172.") ||
    address.startsWith("169.254.") ||
    address.startsWith("198.18.") ||
    address.startsWith("198.19.")
  )
}

export function getLanIPs() {
  const nets = networkInterfaces()
  const results: string[] = []
  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue
    for (const info of net) {
      if (info.internal || info.family !== "IPv4") continue
      if (!isUsableLanAddress(info.address)) continue
      results.push(info.address)
    }
  }
  return results
}
