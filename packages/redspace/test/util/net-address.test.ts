import { describe, expect, test } from "bun:test"
import { classifyAddress, assertPublicDestination, BlockedDestinationError } from "@/util/net-address"

const blocked = (address: string, reasonPart: string) => {
  const result = classifyAddress(address)
  expect(result, `${address} should parse`).toBeDefined()
  expect(result!.public, `${address} should be blocked`).toBe(false)
  expect(result!.reason).toContain(reasonPart)
}

const allowed = (address: string) => {
  const result = classifyAddress(address)
  expect(result, `${address} should parse`).toBeDefined()
  expect(result!.public, `${address} should be public`).toBe(true)
}

describe("classifyAddress", () => {
  test("rejects IPv4 loopback, private and link-local ranges", () => {
    blocked("127.0.0.1", "loopback")
    blocked("127.255.255.254", "loopback")
    blocked("10.0.0.1", "private 10")
    blocked("172.16.0.1", "private 172")
    blocked("172.31.255.255", "private 172")
    blocked("192.168.1.1", "private 192.168")
    // 云元数据端点：这条是 SSRF 里最经典的目标
    blocked("169.254.169.254", "link-local")
    blocked("0.0.0.0", "this-network")
  })

  test("rejects the ranges that are easy to forget", () => {
    blocked("100.64.0.1", "carrier-grade NAT")
    blocked("100.127.255.255", "carrier-grade NAT")
    blocked("192.0.0.1", "IETF protocol")
    blocked("198.18.0.1", "benchmarking")
    blocked("198.19.255.255", "benchmarking")
    blocked("224.0.0.1", "multicast")
    blocked("239.255.255.255", "multicast")
    blocked("255.255.255.255", "reserved")
    blocked("192.0.2.5", "documentation")
    blocked("198.51.100.5", "documentation")
    blocked("203.0.113.5", "documentation")
  })

  test("allows ordinary public IPv4 including range neighbours", () => {
    allowed("1.1.1.1")
    allowed("8.8.8.8")
    allowed("172.15.255.255") // 紧邻 172.16.0.0/12 下界
    allowed("172.32.0.0") // 紧邻上界
    allowed("100.63.255.255") // 紧邻 100.64.0.0/10
    allowed("100.128.0.0")
    allowed("192.167.255.255")
    allowed("192.169.0.0")
    allowed("169.253.255.255")
    allowed("169.255.0.0")
    allowed("223.255.255.255") // 紧邻 224/4
  })

  test("rejects IPv6 loopback, ULA, link-local and multicast", () => {
    blocked("::1", "loopback")
    blocked("::", "unspecified")
    blocked("fc00::1", "unique local")
    blocked("fd12:3456::1", "unique local")
    blocked("fe80::1", "link-local")
    blocked("fe80::1%eth0", "link-local")
    blocked("ff02::1", "multicast")
    blocked("2001:db8::1", "documentation")
    blocked("100::1", "discard")
  })

  test("unwraps IPv4-mapped IPv6", () => {
    blocked("::ffff:127.0.0.1", "loopback")
    blocked("::ffff:169.254.169.254", "link-local")
    blocked("::ffff:192.168.0.1", "private 192.168")
    allowed("::ffff:8.8.8.8")
  })

  // NAT64：把内网 v4 藏进 IPv6 前缀，是最容易漏掉的一条绕过。
  test("unwraps NAT64 embedded IPv4", () => {
    blocked("64:ff9b::169.254.169.254", "NAT64")
    blocked("64:ff9b::127.0.0.1", "NAT64")
    blocked("64:ff9b::10.0.0.1", "NAT64")
    allowed("64:ff9b::8.8.8.8")
  })

  test("allows public IPv6", () => {
    allowed("2606:4700:4700::1111")
    allowed("2001:4860:4860::8888")
  })

  test("returns undefined for things that are not IP literals", () => {
    expect(classifyAddress("example.com")).toBeUndefined()
    expect(classifyAddress("not-an-ip")).toBeUndefined()
    expect(classifyAddress("999.1.1.1")).toBeUndefined()
    expect(classifyAddress("")).toBeUndefined()
  })
})

describe("assertPublicDestination", () => {
  test("blocks an IP-literal URL without touching DNS", async () => {
    await expect(assertPublicDestination(new URL("http://169.254.169.254/latest/meta-data/"))).rejects.toThrow(
      BlockedDestinationError,
    )
    await expect(assertPublicDestination(new URL("http://127.0.0.1:3000/"))).rejects.toThrow(BlockedDestinationError)
    await expect(assertPublicDestination(new URL("http://[::1]:8080/"))).rejects.toThrow(BlockedDestinationError)
  })

  test("names the address and the range in the message", async () => {
    const error = await assertPublicDestination(new URL("http://192.168.1.1/")).catch((e) => e)
    expect(error).toBeInstanceOf(BlockedDestinationError)
    expect(String(error.message)).toContain("192.168.1.1")
    expect(String(error.message)).toContain("private 192.168.0.0/16")
  })

  test("allows a public IP literal", async () => {
    await assertPublicDestination(new URL("https://1.1.1.1/"))
  })

  // localhost 在多数系统上解析到 127.0.0.1 / ::1，走的是解析分支而不是字面量分支。
  test("blocks a hostname that resolves to loopback", async () => {
    await expect(assertPublicDestination(new URL("http://localhost:3000/"))).rejects.toThrow(BlockedDestinationError)
  })
})

// allow_private_hosts 是"我要访问本地 dev server"，不是"打开一切内网"。
describe("allowPrivate opt-in", () => {
  const allow = { allowPrivate: true }

  test("opens the addresses people actually run services on", async () => {
    await assertPublicDestination(new URL("http://127.0.0.1:3000/"), allow)
    await assertPublicDestination(new URL("http://localhost:3000/"), allow)
    await assertPublicDestination(new URL("http://[::1]:8080/"), allow)
    await assertPublicDestination(new URL("http://192.168.1.10/"), allow)
    await assertPublicDestination(new URL("http://10.1.2.3/"), allow)
    await assertPublicDestination(new URL("http://172.20.0.5/"), allow)
    await assertPublicDestination(new URL("http://[fd00::1]/"), allow)
  })

  test("still refuses cloud metadata and other never-legitimate ranges", async () => {
    await expect(assertPublicDestination(new URL("http://169.254.169.254/"), allow)).rejects.toThrow(
      BlockedDestinationError,
    )
    await expect(assertPublicDestination(new URL("http://[fe80::1]/"), allow)).rejects.toThrow(BlockedDestinationError)
    await expect(assertPublicDestination(new URL("http://224.0.0.1/"), allow)).rejects.toThrow(BlockedDestinationError)
    await expect(assertPublicDestination(new URL("http://255.255.255.255/"), allow)).rejects.toThrow(
      BlockedDestinationError,
    )
    await expect(assertPublicDestination(new URL("http://0.0.0.0/"), allow)).rejects.toThrow(BlockedDestinationError)
    // NAT64 包着 link-local 同样不给过
    await expect(assertPublicDestination(new URL("http://[64:ff9b::169.254.169.254]/"), allow)).rejects.toThrow(
      BlockedDestinationError,
    )
  })

  test("NAT64 wrapping a loopback follows the loopback verdict", async () => {
    await expect(assertPublicDestination(new URL("http://[64:ff9b::127.0.0.1]/"))).rejects.toThrow(
      BlockedDestinationError,
    )
    await assertPublicDestination(new URL("http://[64:ff9b::127.0.0.1]/"), allow)
  })
})
