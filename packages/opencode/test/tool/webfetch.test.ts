import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Config } from "@/config/config"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer, Config.defaultLayer),
)

// 260828 cc：这些用例都起本地 Bun.serve 再 fetch 它，落在 webfetch 的非公网目的地
// 守卫里。放开配置而不是放宽守卫 —— 它们同时充当"本地地址要显式开"这条契约的用例。
const allowLocal = { config: { webfetch: { allow_private_hosts: true } } }

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
    allowLocal,
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
    allowLocal,
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
    allowLocal,
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
    allowLocal,
  )

  // ── 目的地守卫 ────────────────────────────────────────────────────────────
  //
  // 260828 cc：此前 webfetch 只检查 scheme。模型给出 http://169.254.169.254/ 会照常
  // 发出去，而用户对 webfetch 选过一次"始终允许"（always: ["*"]）之后连审批都不再出现。

  it.instance("refuses a non-public destination by default", () =>
    withFetch(
      () => new Response("should never be read", { status: 200, headers: { "content-type": "text/plain" } }),
      (url) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(exec({ url: new URL("/x.txt", url).toString(), format: "text" }))
          expect(exit._tag).toBe("Failure")
          expect(String((exit as { cause: unknown }).cause)).toContain("non-public address")
        }),
    ),
  )

  it.instance(
    "names the blocked address so the model can tell what happened",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(exec({ url: "http://169.254.169.254/latest/meta-data/", format: "text" }))
        expect(exit._tag).toBe("Failure")
        const cause = String((exit as { cause: unknown }).cause)
        expect(cause).toContain("169.254.169.254")
        expect(cause).toContain("link-local")
      }),
  )

  it.instance(
    "follows redirects manually and returns the final body",
    () =>
      withFetch(
        (req) => {
          const path = new URL(req.url).pathname
          if (path === "/one") return new Response(null, { status: 302, headers: { location: "/two" } })
          if (path === "/two") return new Response(null, { status: 301, headers: { location: "/three" } })
          return new Response("landed", { status: 200, headers: { "content-type": "text/plain" } })
        },
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/one", url).toString(), format: "text" })
            expect(result.output).toBe("landed")
          }),
      ),
    allowLocal,
  )

  // 逐跳校验的核心用例：首跳被 allow_private_hosts 放行，但重定向到云元数据端点
  // 仍然必须拦下 —— 那个配置只放宽"人会在上面跑服务"的几类地址。
  it.instance(
    "refuses a redirect that leaves for a never-allowed range",
    () =>
      withFetch(
        () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
        (url) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(exec({ url: new URL("/hop", url).toString(), format: "text" }))
            expect(exit._tag).toBe("Failure")
            const cause = String((exit as { cause: unknown }).cause)
            expect(cause).toContain("169.254.169.254")
            expect(cause).toContain("link-local")
          }),
      ),
    allowLocal,
  )

  it.instance(
    "refuses a redirect to a non-HTTP(S) scheme",
    () =>
      withFetch(
        () => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }),
        (url) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(exec({ url: new URL("/hop", url).toString(), format: "text" }))
            expect(exit._tag).toBe("Failure")
            expect(String((exit as { cause: unknown }).cause)).toContain("non-HTTP(S)")
          }),
      ),
    allowLocal,
  )

  it.instance(
    "bounds the redirect chain",
    () =>
      withFetch(
        (req) => {
          const n = Number(new URL(req.url).pathname.slice(1)) || 0
          return new Response(null, { status: 302, headers: { location: `/${n + 1}` } })
        },
        (url) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(exec({ url: new URL("/0", url).toString(), format: "text" }))
            expect(exit._tag).toBe("Failure")
            expect(String((exit as { cause: unknown }).cause)).toContain("Too many redirects")
          }),
      ),
    allowLocal,
  )
})
