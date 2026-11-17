// 出网探针：在真 Node 进程里跑生产路径——装全局 dispatcher、用全局 fetch 发请求、
// 由本地假代理确认「确实走了代理」。由 proxy-dispatcher.test.ts spawn。
// 单独成文件是为了避开嵌套字符串转义。
//
// ⚠️ 判据是 **CONNECT 请求行**，不是 absolute-form。实测 undici 7.29 的 ProxyAgent
// 对 `http:` origin 也发 `CONNECT host:80`，而不是转发绝对 URL —— 上游 harness 那篇
// note 用的 absolute-form 判据对它不成立。所以假代理必须实现真隧道：应答 200 之后
// 把 socket 直接接到本地 HTTP 服务器上（无论客户端说要连哪个主机），客户端于是
// 在隧道里跟它以为的 example.invalid 说话。
const http = require("node:http")
const net = require("node:net")
const { Agent, ProxyAgent, setGlobalDispatcher } = require("undici")

const connects = []

// 隧道尽头：客户端最终说话的对象
const upstream = http.createServer((_req, res) => {
  res.writeHead(200)
  res.end("P")
})
// 直连对照：loopback 请求应当直达这里，代理不该看到它
const direct = http.createServer((_req, res) => {
  res.writeHead(200)
  res.end("D")
})

const proxy = http.createServer((_req, res) => {
  res.writeHead(405)
  res.end()
})
proxy.on("connect", (req, clientSocket, head) => {
  connects.push(req.url)
  const target = net.connect(upstream.address().port, "127.0.0.1", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head && head.length) target.write(head)
    target.pipe(clientSocket)
    clientSocket.pipe(target)
  })
  target.on("error", () => clientSocket.destroy())
  clientSocket.on("error", () => target.destroy())
})

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)))

const isLoopback = (h) => {
  const host = h.replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "::1" || /^127\./.test(host) || host === "0.0.0.0"
}
const shouldProxy = (origin) => {
  try {
    const u = new URL(origin)
    return (u.protocol === "http:" || u.protocol === "https:") && !isLoopback(u.hostname)
  } catch {
    return false
  }
}

async function main() {
  await listen(upstream)
  const directPort = await listen(direct)
  const proxyPort = await listen(proxy)

  setGlobalDispatcher(
    new Agent({
      factory: (origin, opts) =>
        shouldProxy(String(origin))
          ? new ProxyAgent({ ...opts, uri: "http://127.0.0.1:" + proxyPort })
          : new Agent(opts),
    }),
  )

  // 外网域名：故意用 .invalid，DNS 一定解析不了 —— 能拿到响应就只可能是隧道接走了
  const viaProxy = await fetch("http://example.invalid/probe").then((r) => r.text())
  // loopback：必须绕过代理直达
  const viaDirect = await fetch("http://127.0.0.1:" + directPort + "/local").then((r) => r.text())

  process.stdout.write(JSON.stringify({ viaProxy, viaDirect, connects }))
  upstream.close()
  direct.close()
  proxy.close()
  process.exit(0)
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }))
  process.exit(1)
})
