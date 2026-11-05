import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Server } from "../../src/server/server"
import * as Log from "@redcode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffect(testStateLayer)

function app() {
  return Server.Default().app
}
type TestApp = ReturnType<typeof app>
type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

const handlerScoped = Effect.acquireRelease(
  Effect.sync(() => HttpApiApp.webHandler()),
  (handler) => Effect.promise(() => handler.dispose()).pipe(Effect.ignore),
)

const request = Effect.fnUntraced(function* (
  handler: TestHandler,
  route: string,
  directory: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers)
  headers.set("x-redcode-directory", directory)
  return yield* Effect.promise(() =>
    Promise.resolve(
      handler.handler(
        new Request(`http://localhost${route}`, {
          ...init,
          headers,
        }),
        context,
      ),
    ),
  )
})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const readResponse = Effect.fnUntraced(function* (input: { app: TestApp; path: string; headers: HeadersInit }) {
  const response = yield* Effect.promise(() =>
    Promise.resolve(input.app.request(input.path, { method: "POST", headers: input.headers })),
  )
  return {
    status: response.status,
    body: yield* Effect.promise(() => response.text()),
  }
})

describe("mcp HttpApi", () => {
  it.instance(
    "serves status endpoint",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped
        const response = yield* request(handler, McpPaths.status, tmp.directory)

        expect(response.status).toBe(200)
        expect(yield* json(response)).toEqual({ demo: { status: "disabled" } })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves add, connect, and disconnect endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped
        const added = yield* request(handler, McpPaths.status, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "added",
            config: {
              type: "local",
              command: ["echo", "added"],
              enabled: false,
            },
          }),
        })
        expect(added.status).toBe(200)
        expect(yield* json(added)).toMatchObject({ added: { status: "disabled" } })

        const connected = yield* request(handler, "/mcp/demo/connect", tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)
        expect(yield* json(connected)).toBe(true)

        const disconnected = yield* request(handler, "/mcp/demo/disconnect", tmp.directory, { method: "POST" })
        expect(disconnected.status).toBe(200)
        expect(yield* json(disconnected)).toBe(true)
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves deterministic OAuth endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped
        const start = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "POST" })
        expect(start.status).toBe(400)

        const authenticate = yield* request(handler, "/mcp/demo/auth/authenticate", tmp.directory, { method: "POST" })
        expect(authenticate.status).toBe(400)

        const removed = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(yield* json(removed)).toEqual({ success: true })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "returns unsupported OAuth error responses",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const dir = tmp.directory
        const headers = { "x-redcode-directory": dir }

        yield* Effect.forEach(["/mcp/demo/auth", "/mcp/demo/auth/authenticate"], (path) =>
          Effect.gen(function* () {
            const response = yield* readResponse({ app: app(), path, headers })

            expect(response).toEqual({
              status: 400,
              body: JSON.stringify({ error: "MCP server demo does not support OAuth" }),
            })
          }),
        )
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "reports a missing command with a startup hint instead of a bare error",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped

        const connected = yield* request(handler, "/mcp/missing/connect", tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)

        const statuses = yield* json<Record<string, { status: string; error?: string }>>(
          yield* request(handler, McpPaths.status, tmp.directory),
        )
        const failed = statuses["missing"]
        expect(failed?.status).toBe("failed")
        // 261105 Red 证据链：命令不存在时给出排查建议；stderr 为空则不拼证据段。
        // POSIX 上 spawn 错误以 ENOENT 冒出、走「could not be started」分支；Windows 上
        // transport 吞掉 spawn 错误只报 Connection closed、走「exited during startup」分支。
        const expected = process.platform === "win32" ? "exited during startup" : "could not be started"
        expect(failed?.error).toContain(expected)
        expect(failed?.error).not.toContain("stdio stderr")
      }),
    {
      config: {
        mcp: {
          missing: {
            type: "local",
            command: ["definitely-not-a-real-command-redcode-mcp-test"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "attaches sanitized stderr evidence when the server exits during startup",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped

        const connected = yield* request(handler, "/mcp/crashy/connect", tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)

        const statuses = yield* json<Record<string, { status: string; error?: string }>>(
          yield* request(handler, McpPaths.status, tmp.directory),
        )
        const failed = statuses["crashy"]
        expect(failed?.status).toBe("failed")
        expect(failed?.error).toContain("exited during startup")
        expect(failed?.error).toContain("stdio stderr")
        // 261105 Red 证据脱敏：key 含 TOKEN 的赋值整值遮蔽，明文不得出现在错误里。
        expect(failed?.error).toContain("[redacted]")
        expect(failed?.error).not.toContain("supersecret123")
        expect(failed!.error!.length).toBeLessThan(1200)
      }),
    {
      config: {
        mcp: {
          crashy: {
            type: "local",
            command: [process.execPath, "-e", "console.error('API_TOKEN=supersecret123'); process.exit(1)"],
            enabled: false,
          },
        },
      },
    },
  )
})
