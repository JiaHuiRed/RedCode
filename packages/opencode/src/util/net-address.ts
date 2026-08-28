// 260828 cc：网络目的地分类。webfetch 此前只检查 scheme，模型给出 http://169.254.169.254/
// 或 http://192.168.1.1/ 会照常发出去；用户一旦对 webfetch 选过"始终允许"（always: ["*"]），
// 连审批都不再出现。这里给出"这个地址是不是公网单播"的唯一判据。
//
// 已知边界：resolve 之后由 fetch 再解析一次，中间存在 DNS rebinding 的 TOCTOU 窗口。
// 真正堵死要按解析结果直连 IP 并自带 Host 头，fetch 做不到；上游 harness 同样只做到
// 解析期校验。这里不假装覆盖了它。
import net from "net"
import dns from "dns/promises"

export interface Classification {
  readonly public: boolean
  /** 非公网时说明命中哪一类，用于错误信息。 */
  readonly reason?: string
  /**
   * 配置 `webfetch.allow_private_hosts` 能否放行这一类。
   *
   * 能：人真的会在上面跑服务的地址 —— 环回、RFC1918、CGNAT、ULA。
   * 不能：link-local（`169.254/16` 与 `fe80::/10`，云元数据端点就在这里）、组播、
   * 保留、未指定、文档与基准测试段。这些没有任何正当的 webfetch 用途，所以"我要访问
   * 本地 dev server"这个开关不该顺带把它们一起打开。
   */
  readonly overridable?: boolean
}

const PUBLIC: Classification = { public: true }
const block = (reason: string): Classification => ({ public: false, reason })
const blockLocal = (reason: string): Classification => ({ public: false, reason, overridable: true })

function parseIPv4(input: string): number[] | undefined {
  if (!net.isIPv4(input)) return undefined
  return input.split(".").map((part) => Number(part))
}

// 展开成 16 字节。`::` 缩写、以及尾部内嵌 IPv4（::ffff:1.2.3.4）都要处理。
function parseIPv6(input: string): number[] | undefined {
  if (!net.isIPv6(input)) return undefined
  let text = input
  // 去掉 zone id（fe80::1%eth0）
  const zone = text.indexOf("%")
  if (zone !== -1) text = text.slice(0, zone)

  let tailV4: number[] | undefined
  const lastColon = text.lastIndexOf(":")
  const tail = text.slice(lastColon + 1)
  if (tail.includes(".")) {
    tailV4 = parseIPv4(tail)
    if (!tailV4) return undefined
    text = text.slice(0, lastColon + 1) + "0:0"
  }

  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const toGroups = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)))
  const head = toGroups(halves[0] ?? "")
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : []
  const groups =
    halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill(0), ...rest] : head
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return undefined

  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff])
  if (tailV4) {
    bytes[12] = tailV4[0]
    bytes[13] = tailV4[1]
    bytes[14] = tailV4[2]
    bytes[15] = tailV4[3]
  }
  return bytes
}

function classifyIPv4(b: number[]): Classification {
  const [a, second] = b
  if (a === 0) return block("this-network 0.0.0.0/8")
  if (a === 10) return blockLocal("private 10.0.0.0/8")
  if (a === 127) return blockLocal("loopback 127.0.0.0/8")
  if (a === 100 && second >= 64 && second <= 127) return blockLocal("carrier-grade NAT 100.64.0.0/10")
  if (a === 169 && second === 254) return block("link-local 169.254.0.0/16 (cloud metadata)")
  if (a === 172 && second >= 16 && second <= 31) return blockLocal("private 172.16.0.0/12")
  if (a === 192 && second === 0 && b[2] === 0) return block("IETF protocol assignments 192.0.0.0/24")
  if (a === 192 && second === 0 && b[2] === 2) return block("documentation 192.0.2.0/24")
  if (a === 192 && second === 168) return blockLocal("private 192.168.0.0/16")
  if (a === 198 && (second === 18 || second === 19)) return block("benchmarking 198.18.0.0/15")
  if (a === 198 && second === 51 && b[2] === 100) return block("documentation 198.51.100.0/24")
  if (a === 203 && second === 0 && b[2] === 113) return block("documentation 203.0.113.0/24")
  if (a >= 224 && a <= 239) return block("multicast 224.0.0.0/4")
  if (a >= 240) return block("reserved 240.0.0.0/4")
  return PUBLIC
}

function classifyIPv6(b: number[]): Classification {
  const zeros = (upto: number) => b.slice(0, upto).every((byte) => byte === 0)

  // ::ffff:a.b.c.d —— IPv4 映射，按内嵌的 v4 判。
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return classifyIPv4(b.slice(12))
  // 64:ff9b::/96 与 64:ff9b:1::/48 —— NAT64，内嵌 v4 同样要判，否则
  // 64:ff9b::169.254.169.254 就是一条绕过。
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    const embedded = classifyIPv4(b.slice(12))
    if (embedded.public) return PUBLIC
    return { public: false, reason: `NAT64 mapping to ${embedded.reason}`, overridable: embedded.overridable }
  }
  if (zeros(15) && b[15] === 0) return block("unspecified ::")
  if (zeros(15) && b[15] === 1) return blockLocal("loopback ::1")
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return block("discard 100::/64")
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return block("documentation 2001:db8::/32")
  if ((b[0] & 0xfe) === 0xfc) return blockLocal("unique local fc00::/7")
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return block("link-local fe80::/10")
  if (b[0] === 0xff) return block("multicast ff00::/8")
  return PUBLIC
}

/** 判断一个 IP 字面量是不是公网单播地址。非 IP 字面量返回 undefined。 */
export function classifyAddress(address: string): Classification | undefined {
  const v4 = parseIPv4(address)
  if (v4) return classifyIPv4(v4)
  const v6 = parseIPv6(address)
  if (v6) return classifyIPv6(v6)
  return undefined
}

export class BlockedDestinationError extends Error {
  constructor(
    readonly host: string,
    readonly address: string,
    reason: string,
  ) {
    super(
      `Refusing to fetch "${host}": it resolves to ${address}, a non-public address (${reason}). ` +
        "Use a shell command if you genuinely need to reach a local or internal address.",
    )
    this.name = "BlockedDestinationError"
  }
}

export class UnresolvableHostError extends Error {
  constructor(readonly host: string) {
    super(`Refusing to fetch "${host}": its address could not be resolved, so it cannot be proven public.`)
    this.name = "UnresolvableHostError"
  }
}

export interface DestinationOptions {
  /**
   * `webfetch.allow_private_hosts`。放行 `overridable` 的那几类（环回 / RFC1918 /
   * CGNAT / ULA），**不**放行 link-local、组播、保留等类 —— 见 `Classification.overridable`。
   */
  readonly allowPrivate?: boolean
}

/**
 * 校验一个 URL 的目的地可达。主机名是 IP 字面量时直接判；否则解析并要求**每一条**
 * 解析结果都通过 —— 一个名字同时给出公网和内网地址时，fetch 选哪条不由我们决定，
 * 所以只要有一条不安全就整体拒绝。
 */
export async function assertPublicDestination(url: URL, options: DestinationOptions = {}): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const permitted = (c: Classification) => c.public || (!!options.allowPrivate && !!c.overridable)

  const literal = classifyAddress(host)
  if (literal) {
    if (!permitted(literal)) throw new BlockedDestinationError(url.hostname, host, literal.reason!)
    return
  }

  let resolved: { address: string }[]
  try {
    resolved = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new UnresolvableHostError(url.hostname)
  }
  if (resolved.length === 0) throw new UnresolvableHostError(url.hostname)

  for (const entry of resolved) {
    const classification = classifyAddress(entry.address)
    if (!classification) throw new UnresolvableHostError(url.hostname)
    if (!permitted(classification)) {
      throw new BlockedDestinationError(url.hostname, entry.address, classification.reason!)
    }
  }
}

export * as NetAddress from "./net-address"
