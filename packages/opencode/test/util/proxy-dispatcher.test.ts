import { describe, expect, test } from "bun:test"
import path from "node:path"
import { shouldProxy } from "../../src/util/proxy-dispatcher"

// 260903 cc 出网测试：读代码判断不了「请求到底去了哪」。
// 路由判据用表驱动穷举（直接打真实导出），隧道行为在**真 Node 子进程**里由假代理确认。

describe("shouldProxy · loopback 恒绕过", () => {
  // 这一组是硬性要求不是优化：GUI↔sidecar、Ollama 这类本地 provider、
  // 以及全部本地测试服务器都在 loopback 上，代理它们会形成回环。
  const bypass = [
    "http://localhost:4096/session",
    "http://127.0.0.1:11434/api/tags",
    "http://127.0.0.1:4096",
    "http://127.9.9.9:8080", // 127.0.0.0/8 整段，不只是 127.0.0.1
    "http://[::1]:4096/x",
    "http://0.0.0.0:3000",
    "http://foo.localhost:5173",
  ]
  for (const url of bypass) {
    test(url, () => expect(shouldProxy(url, "")).toBe(false))
  }

  test("裸写的 ::1 也认（undici 自带匹配器会把它读成主机 : 端口 1，永不豁免）", () => {
    expect(shouldProxy(new URL("http://[::1]:9229/"), "")).toBe(false)
  })
})

describe("shouldProxy · 非 loopback 默认走代理", () => {
  for (const url of ["https://models.dev/api.json", "https://api.anthropic.com/v1/messages", "http://example.com"]) {
    test(url, () => expect(shouldProxy(url, "")).toBe(true))
  }
})

describe("shouldProxy · NO_PROXY", () => {
  // 取自本机真实值，外加两条形态（后缀、带端口）
  const NO = "localhost,127.0.0.1,192.168.*,10.*,172.16.*,.internal.corp,example.com:8080"

  test("通配前缀 192.168.*", () => expect(shouldProxy("http://192.168.1.7:80/x", NO)).toBe(false))
  test("通配前缀 10.*", () => expect(shouldProxy("http://10.0.0.5/x", NO)).toBe(false))
  test("后缀匹配 .internal.corp 命中子域", () => expect(shouldProxy("https://git.internal.corp/repo", NO)).toBe(false))
  test("后缀匹配也命中裸域", () => expect(shouldProxy("https://internal.corp/", NO)).toBe(false))
  test("带端口的条目只在端口一致时命中", () => {
    expect(shouldProxy("http://example.com:8080/x", NO)).toBe(false)
    expect(shouldProxy("http://example.com:9090/x", NO)).toBe(true)
  })
  test("不在名单里的照常走代理", () => expect(shouldProxy("https://models.dev/api.json", NO)).toBe(true))
  test("* 表示全部绕过", () => expect(shouldProxy("https://models.dev/", "*")).toBe(false))
  test("空 NO_PROXY 不绕过任何非 loopback", () => expect(shouldProxy("https://models.dev/", "")).toBe(true))
  test("后缀不做子串匹配（notexample.com 不该被 example.com 命中）", () =>
    expect(shouldProxy("https://notexample.com/", "example.com")).toBe(true))
})

describe("shouldProxy · 非 http(s) 与畸形输入保持直连", () => {
  for (const url of ["ws://example.com/x", "file:///c:/tmp/x", "ftp://example.com/x"]) {
    test(url, () => expect(shouldProxy(url, "")).toBe(false))
  }
  test("解析不了的字符串不抛异常、判直连", () => expect(shouldProxy("不是-url", "")).toBe(false))
})

// 必须开真 Node 子进程：undici 的全局 dispatcher 不是 Bun fetch 会读的东西，
// 生产上这条路只在 sidecar 的 Node 里跑，在 Bun 测试进程内验等于什么都没验。
describe("真 Node 进程里的出网行为", () => {
  test("装了策略之后全局 fetch 走代理，loopback 仍直连", () => {
    const probe = path.join(import.meta.dir, "proxy-egress-probe.cjs")
    const proc = Bun.spawnSync(["node", probe], { cwd: path.join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" })
    const stdout = new TextDecoder().decode(proc.stdout).trim()
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    expect(stdout, `stderr: ${stderr}`).not.toBe("")

    const got = JSON.parse(stdout)
    expect(got.error).toBeUndefined()
    // .invalid 域名 DNS 必然解析不了 —— 能拿到响应就只可能是代理接走了
    expect(got.viaProxy).toBe("P")
    // loopback 绕过代理，直达本地服务器
    expect(got.viaDirect).toBe("D")
    // 判据是 CONNECT 请求行 —— 实测 undici 7.29 的 ProxyAgent 对 http: 也发
    // CONNECT host:80 而不是转发绝对 URL（上游 harness 那篇的 absolute-form 判据
    // 对它不成立），所以假代理实现的是真隧道，探针里写了完整因由。
    expect(got.connects).toEqual(["example.invalid:80"])
  }, 30000)
})
