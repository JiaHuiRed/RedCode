import path from "node:path"
import { createRequire } from "node:module"
import { mkdir, writeFile } from "node:fs/promises"

// 261009 Red 私有验证夹具：真实 HTTP/GUI 链路的漏广播补拉 E2E 用，只在
// <repo>/.redcode/temp 隔离环境下运行，禁止指向真实数据目录。
const sourceRoot = path.resolve(import.meta.dir, "..")
const scratchRoot = path.join(sourceRoot, ".redcode", "temp")
const inside = (parent: string, child: string) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
const requireInsideScratch = (name: string) => {
  const value = process.env[name]
  if (!value || !path.isAbsolute(value) || !inside(scratchRoot, value)) {
    throw new Error(`${name} must be an absolute path inside ${scratchRoot}`)
  }
  return path.resolve(value)
}

// Keep all test state private and establish environment before importing application code.
const testHome = requireInsideScratch("REDCODE_TEST_HOME")
const database = requireInsideScratch("REDCODE_DB")
const projectDirectory = requireInsideScratch("REDCODE_TEST_PROJECT")
if (process.env.REDCODE_SESSION_CHANGE_PROBE !== "1") {
  throw new Error("Set REDCODE_SESSION_CHANGE_PROBE=1 to enable private probe routes")
}
if (path.basename(database).toLowerCase() !== "session-change-browser.db") {
  throw new Error("REDCODE_DB must point to session-change-browser.db")
}
if (path.basename(testHome).toLowerCase() !== "session-change-home") {
  throw new Error("REDCODE_TEST_HOME must point to session-change-home")
}
if (path.basename(projectDirectory).toLowerCase() !== "session-change-project") {
  throw new Error("REDCODE_TEST_PROJECT must point to session-change-project")
}

process.env.HOME = testHome
process.env.USERPROFILE = testHome
process.env.REDCODE_DB = database
process.env.REDCODE_SKIP_MIGRATIONS = "false"
process.env.REDCODE_SERVER_PASSWORD = ""
delete process.env.REDCODE_SERVER_USERNAME
await mkdir(testHome, { recursive: true })
await mkdir(path.dirname(database), { recursive: true })
await mkdir(projectDirectory, { recursive: true })
await mkdir(path.join(projectDirectory, ".git"), { recursive: true })
const initialized = Bun.spawnSync(["git", "-C", projectDirectory, "init"], { stdout: "pipe", stderr: "pipe" })
if (initialized.exitCode !== 0) throw new Error("Could not initialize the private fixture repository")
process.chdir(projectDirectory)
await writeFile(
  path.join(projectDirectory, "redcode.json"),
  JSON.stringify({ plugin: [], mcp: {}, tools: {} }),
)

const requireFromMain = createRequire(path.join(sourceRoot, "packages", "opencode", "package.json"))
const { Effect } = requireFromMain("effect")
const modulePath = (relative: string) => path.join(sourceRoot, "packages", "opencode", "src", relative)
const Server = await import(modulePath("server/server.ts"))
const GlobalBus = await import(modulePath("bus/global.ts"))
const SyncEvent = await import(modulePath("sync/index.ts"))
const MessageV2 = await import(modulePath("session/message-v2.ts"))
const MessageSchema = await import(modulePath("session/schema.ts"))
const ProviderSchema = await import(modulePath("provider/schema.ts"))
const AppRuntimeModule = await import(modulePath("effect/app-runtime.ts"))
const Fixture = await import(path.join(sourceRoot, "packages", "opencode", "test", "fixture", "fixture.ts"))
const app = Server.Default().app
const token = "session-change-fixture"
const sessions: string[] = []
const headers = { "x-redcode-directory": projectDirectory }
// 私有夹具脚本非生产代码：Effect 泛型标注成本高于收益，接受这里的宽类型。
const sessionEffect = (effect: any) =>
  Effect.runPromise(
    effect.pipe(Fixture.provideInstance(projectDirectory), Effect.provide(AppRuntimeModule.AppLayer)),
  )

const createSession = async (title: string) => {
  const response = await app.fetch(
    new Request("http://127.0.0.1/session", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  )
  if (!response.ok) throw new Error(`Session fixture creation failed: HTTP ${response.status}`)
  const value = (await response.json()) as { id: string }
  sessions.push(value.id)
  return value.id
}

const sessionA = await createSession("Session change fixture A")
const sessionB = await createSession("Session change fixture B")
const messageID = MessageSchema.MessageID.ascending()
const partID = MessageSchema.PartID.ascending()
await sessionEffect(
  Effect.gen(function* () {
    const id = MessageSchema.SessionID.make(sessionA)
    yield* SyncEvent.use.run(
      MessageV2.Event.Updated,
      {
        sessionID: id,
        info: {
          id: messageID,
          sessionID: id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: {
            providerID: ProviderSchema.ProviderID.make("test"),
            modelID: ProviderSchema.ModelID.make("test"),
          },
          tools: {},
          mode: "",
        },
      },
      { publish: false },
    )
    yield* SyncEvent.use.run(
      MessageV2.Event.PartUpdated,
      {
        sessionID: id,
        part: {
          id: partID,
          sessionID: id,
          messageID,
          type: "text",
          text: "original browser probe text",
        },
        time: Date.now(),
      },
      { publish: false },
    )
  }),
)

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })
const probeJSON = (request: Request, value: unknown, status = 200) => {
  const origin = request.headers.get("origin")
  const headers = new Headers({ "cache-control": "no-store" })
  if (origin?.startsWith("http://localhost:") || origin?.startsWith("http://127.0.0.1:")) {
    headers.set("access-control-allow-origin", origin)
    headers.set("vary", "Origin")
  }
  return Response.json(value, { status, headers })
}
const apiJSON = async (pathname: string) => {
  const response = await app.fetch(
    new Request(`http://127.0.0.1${pathname}`, { headers }),
  )
  return { status: response.status, body: await response.json() }
}
// 回调里引用 server.port，须显式标注类型打破自引用推断。
const server: Bun.Server<never> = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/__probe/")) return app.fetch(request)
    if (url.hostname !== "127.0.0.1") return json({ error: "loopback only" }, 403)
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("origin")
      if (!origin?.startsWith("http://localhost:") && !origin?.startsWith("http://127.0.0.1:")) {
        return json({ error: "loopback origin only" }, 403)
      }
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-redcode-directory, x-session-change-probe",
          "access-control-max-age": "600",
          vary: "Origin",
        },
      })
    }
    if (request.headers.get("x-session-change-probe") !== token) return json({ error: "forbidden" }, 403)
    if (request.method === "GET" && url.pathname === "/__probe/info") {
      return probeJSON(request, {
        baseURL: `http://127.0.0.1:${server.port}`,
        directory: projectDirectory,
        sessionIDs: sessions,
        sourceRoot,
        database,
        messageID,
        partID,
        capabilities: ["real-http-api", "real-gui-handler", "manual-reconnect", "session-part-edit"],
      })
    }
    if (request.method === "POST" && url.pathname === "/__probe/reconnect") {
      GlobalBus.GlobalBus.emit("event", {
        payload: { type: "server.connected", properties: {} },
      })
      return probeJSON(request, { emitted: true })
    }
    // 261009 Red 有界窗口冒烟只造小文本：最多 1000 条，live 只允许单条，仍限定隔离 DB。
    if (request.method === "POST" && url.pathname === "/__probe/window") {
      const body: unknown = await request.json()
      if (typeof body !== "object" || body === null) return probeJSON(request, { error: "invalid body" }, 400)
      const count = "count" in body ? body.count : 1000
      const live = "live" in body && body.live === true
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 1000 || (live && count !== 1))
        return probeJSON(request, { error: "invalid count" }, 400)
      const existing = "sessionID" in body ? body.sessionID : undefined
      if (existing !== undefined && (typeof existing !== "string" || !sessions.includes(existing)))
        return probeJSON(request, { error: "unknown fixture session" }, 400)
      const target = typeof existing === "string" ? existing : await createSession("Message-window fixture")
      const base = Date.now() - count * 10
      const messages: { messageID: string; partID: string }[] = await sessionEffect(
        Effect.gen(function* () {
          const id = MessageSchema.SessionID.make(target)
          const result: { messageID: string; partID: string }[] = []
          for (let i = 0; i < count; i++) {
            const messageID = MessageSchema.MessageID.ascending()
            const partID = MessageSchema.PartID.ascending()
            yield* SyncEvent.use.run(
              MessageV2.Event.Updated,
              {
                sessionID: id,
                info: {
                  id: messageID,
                  sessionID: id,
                  role: "user",
                  time: { created: base + i * 10 },
                  agent: "user",
                  model: {
                    providerID: ProviderSchema.ProviderID.make("test"),
                    modelID: ProviderSchema.ModelID.make("test"),
                  },
                  tools: {},
                },
              },
              { publish: live },
            )
            yield* SyncEvent.use.run(
              MessageV2.Event.PartUpdated,
              {
                sessionID: id,
                part: {
                  id: partID,
                  sessionID: id,
                  messageID,
                  type: "text",
                  text: live ? "window live message" : `window message ${i + 1}`,
                },
                time: Date.now(),
              },
              { publish: live },
            )
            result.push({ messageID, partID })
          }
          return result
        }),
      )
      return probeJSON(request, { sessionID: target, count, messages })
    }
    if (request.method === "POST" && url.pathname === "/__probe/modify") {
      await sessionEffect(
        Effect.gen(function* () {
          const id = MessageSchema.SessionID.make(sessionA)
          yield* SyncEvent.use.run(
            MessageV2.Event.PartUpdated,
            {
              sessionID: id,
              part: {
                id: partID,
                sessionID: id,
                messageID,
                type: "text",
                text: "edited browser probe text",
              },
              time: Date.now(),
            },
            { publish: false },
          )
        }),
      )
      return probeJSON(request, { modified: true })
    }
    if (request.method === "GET" && url.pathname === "/__probe/state") {
      return probeJSON(request, {
        sessions: await Promise.all(
          sessions.map(async (id) => ({
            id,
            session: await apiJSON(`/session/${encodeURIComponent(id)}`),
            messages: await apiJSON(`/session/${encodeURIComponent(id)}/message`),
            changes: await apiJSON(`/session/${encodeURIComponent(id)}/changes`),
          })),
        ),
      })
    }
    return probeJSON(request, { error: "not found" }, 404)
  },
})

const onSignal = () => server.stop(true)
process.once("SIGINT", onSignal)
process.once("SIGTERM", onSignal)
console.log(
  JSON.stringify({
    ready: true,
    baseURL: `http://127.0.0.1:${server.port}`,
    directory: projectDirectory,
    sessionIDs: sessions,
    sourceRoot,
    database,
    probeHeader: "x-session-change-probe",
    probeToken: token,
  }),
)
