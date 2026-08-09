import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { serviceUse } from "@/effect/service-use"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { ConfigMCP } from "../config/mcp"
import * as Log from "@redcode-ai/core/util/log"
import { NamedError } from "@redcode-ai/core/util/error"
import { InstallationVersion } from "@redcode-ai/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Global } from "@redcode-ai/core/global"
import * as path from "path"
import * as fs from "fs"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
import os from "os"
import { Cause, Effect, Exit, Layer, Option, Context, Schema, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"

const log = Log.create({ service: "mcp" })
const DEFAULT_TIMEOUT = 30_000

// --- MCP tool disk cache (cache-first: show tools before startup completes) ---
const MCP_TOOLS_CACHE_DIR = path.join(Global.Path.cache, "mcp-tools")

function mcpToolsCachePath(serverName: string) {
  return path.join(MCP_TOOLS_CACHE_DIR, `${sanitize(serverName)}.json`)
}

function writeMcpToolsCache(serverName: string, tools: MCPToolDef[]) {
  try {
    fs.mkdirSync(MCP_TOOLS_CACHE_DIR, { recursive: true })
    fs.writeFileSync(mcpToolsCachePath(serverName), JSON.stringify({ tools, cachedAt: Date.now() }), "utf-8")
  } catch {}
}

function readMcpToolsCache(serverName: string): MCPToolDef[] | undefined {
  try {
    const raw = fs.readFileSync(mcpToolsCachePath(serverName), "utf-8")
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.tools)) return parsed.tools as MCPToolDef[]
  } catch {}
  return undefined
}

// 260607 Red 从 exe 路径向上找 RedCode 项目根（用于 $REDCODE_ROOT 展开）
let redcodeRoot: string | undefined
function isRedcodeRootDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "package.json")) &&
    // 260806 Red 撤掉 260805 加的 .redcode 分支 —— 方向从一开始就错了。$REDCODE_ROOT 要找的是
    // **RedCode 自身的安装/源码根**（用来展开 ./plugins、./seed 这类相对命令），而 .redcode/
    // 是引擎给**每个被打开的项目**自动创建的目录，家目录同样有一份。结果是：只要 exe 路径向上
    // 经过家目录，家目录就被认成安装根，cwd 落到 C:\Users\<user>，全部相对路径 MCP ENOENT
    // （260806 实测：typegraph/sqlite-query/su-prememory/process-mgmt/vision/web-search 全挂）。
    // 补 MEMORY.md 判定也拦不住，因为家目录的 .redcode/MEMORY.md 本来就存在。
    // 标记只认安装根独有的东西：源码根的 redcode.jsonc、种子目录 seed/（原 .opencode）。
    (fs.existsSync(path.join(dir, "redcode.jsonc")) ||
      fs.existsSync(path.join(dir, "seed", "redcode.home.jsonc")) ||
      fs.existsSync(path.join(dir, ".opencode")))
  )
}

// 家目录永远不是安装根：它必然含 .redcode/ 与（多数机器上的）package.json，一旦被认成根，
// $REDCODE_ROOT 会展开到用户主目录，相对路径的 mcp command 全部失败。
function isHomeDir(dir: string): boolean {
  return path.resolve(dir) === path.resolve(os.homedir())
}
function walkUpForRedcodeRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 10; i++) {
    if (!isHomeDir(dir) && isRedcodeRootDir(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ""
}
function findRedcodeRoot(): string {
  if (redcodeRoot) return redcodeRoot
  // 编译产物：从 exe 路径向上找安装根
  let found = walkUpForRedcodeRoot(path.dirname(process.execPath))
  // 260722 Red `bun run dev` 下 execPath=bun.exe，向上永远找不到安装根，此前直接判空回退到
  // InstanceState.directory（当前打开的目标项目目录，跟 RedCode 自己完全无关）——
  // 导致 $REDCODE_ROOT 展开成别的项目路径，relative 的 mcp command 全部 ENOENT/Module not found。
  // 用 import.meta.dirname（源码文件自身位置）再向上找一次；编译产物里这是虚拟 bunfs 路径，
  // fs.existsSync 天然查不到，安全地继续走原有 fallback，不影响编译场景。
  if (!found) found = walkUpForRedcodeRoot(import.meta.dirname)
  redcodeRoot = found
  return found
}

function resolveMcpCwd(mcpCwd: string | undefined, fallback: string): string {
  if (!mcpCwd) return fallback
  // Expand $REDCODE_ROOT — 如果找不到安装根目录，回退到 InstanceState.directory
  const root = findRedcodeRoot()
  // 260610 Red root 为空时（bun run dev 下 execPath=bun.exe，向上找不到安装根）回退 fallback，
  // 否则 $REDCODE_ROOT 残留字面量 → spawn cwd 指向不存在目录 → ENOENT
  let resolved = mcpCwd.replace(/\$REDCODE_ROOT/g, root || fallback)
  // Expand ~/
  if (resolved.startsWith("~/")) resolved = path.join(os.homedir(), resolved.slice(2))
  return resolved
}

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  Schema.Struct({
    server: Schema.String,
  }),
)

export const BrowserOpenFailed = BusEvent.define(
  "mcp.browser.open.failed",
  Schema.Struct({
    mcpName: Schema.String,
    url: Schema.String,
  }),
)

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

type MCPClient = Client

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
// 260624 Red 上游移植: MCP resource template listing
type ResourceTemplateInfo = Awaited<ReturnType<MCPClient["listResourceTemplates"]>>["resourceTemplates"][number]
type McpEntry = NonNullable<Config.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

function remoteURL(key: string, value: string) {
  if (URL.canParse(value)) return new URL(value)
  log.warn("invalid remote mcp url", { key })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

function listTools(key: string, client: MCPClient, timeout: number) {
  return Effect.tryPromise({
    try: () => client.listTools(undefined, { timeout }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((error) => {
      if (!isOutputSchemaValidationError(error)) return Effect.fail(error)

      log.warn("failed to validate MCP tool output schemas, retrying without output schema validation", { key, error })
      return Effect.tryPromise({
        try: () =>
          client.request({ method: "tools/list" }, TolerantListToolsResultSchema, {
            timeout,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.map((result) =>
          result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ),
      )
    }),
  )
}

// Convert MCP tool definition to AI SDK Tool type
// 260807 Red: client 参数改为 getClient 闭包——断线重连（reconnectServer→storeClient）会换新 client，
// 旧实现 execute 捕获当时的 client 引用，超时重连后仍指向已 close 的旧 client → 重试永远 Not connected。
function convertMcpTool(
  mcpTool: MCPToolDef,
  getClient: () => MCPClient | undefined,
  serverName: string,
  reconnectFn?: () => Promise<void>,
  timeout?: number,
): Tool {
  const inputSchema = mcpTool.inputSchema

  // Spread first, then override type to ensure it's always "object"
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  // 260603 Red P1: 工具调用失败自动重连（最多 3 次）
  const MAX_RETRIES = 3
  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown) => {
      let lastError: unknown
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            // 260807 Red: 每次调用从 clients 表取最新 client（s.clients[name] 由 storeClient 更新）
            const client = getClient()
            if (!client) {
              throw new Error(`MCP server "${serverName}" is not connected`)
            }
            // 260603 Red 进度推送：实时记录 MCP 工具调用进度
            let progressLog = ""
            return await client.callTool(
              { name: mcpTool.name, arguments: (args || {}) as Record<string, unknown> },
              CallToolResultSchema,
              {
                onprogress: (progress) => {
                  const msg = progress.message ?? `progress ${progress.progress}${progress.total ? "/" + progress.total : ""}`
                  if (msg !== progressLog) {
                    progressLog = msg
                    log.info("MCP tool progress", { server: serverName, tool: mcpTool.name, ...progress })
                  }
                },
                resetTimeoutOnProgress: true,
                timeout,
              },
          )
        } catch (err) {
          lastError = err
          log.warn("MCP tool call failed", {
            server: serverName,
            tool: mcpTool.name,
            attempt: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
          })
          if (attempt < MAX_RETRIES - 1) {
            if (reconnectFn) {
              try { await reconnectFn() } catch {}
            }
            // 260716 Red 指数退避（1s/2s）：网络型瞬时故障给更多恢复时间，别在同一秒内连打三炮
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
          }
        }
      }
      throw lastError
    },
  })
}

// Convert cached MCP tool definition to a disconnected stub (server not yet connected)
function convertMcpToolCached(mcpTool: MCPToolDef, serverName: string): Tool {
  const inputSchema = mcpTool.inputSchema
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }
  return dynamicTool({
    // 260706 Red: description 必须与 convertMcpTool 保持字节级一致——MCP 连接状态在 session 内
    // 抖动（断线重连/慢启动）时，同一工具会在 connected/cached 两个转换函数间切换，若 description
    // 文案不同则 tool schema JSON 变化，打断 DeepSeek 前缀缓存（miss 从新增内容级变成整前缀级）。
    // "not connected" 提示改放 execute() 抛出的 Error 里，反正断线时调用工具本就会失败。
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async () => {
      throw new Error(`MCP server "${serverName}" is not connected. Tools from disk cache are read-only.`)
    },
  })
}

function defs(key: string, client: MCPClient, timeout?: number) {
  return listTools(key, client, timeout ?? DEFAULT_TIMEOUT).pipe(
    Effect.catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return Effect.succeed(undefined)
    }),
  )
}

function fetchFromClient<T extends { name: string }>(
  clientName: string,
  client: Client,
  listFn: (c: Client) => Promise<T[]>,
  label: string,
) {
  return Effect.tryPromise({
    try: () => listFn(client),
    catch: (e: any) => {
      // 260716 Red MethodNotFound = 该 server 本就没实现这个可选 capability（prompts/resources
      // 等 MCP 规范允许不支持），不是真故障；每次连接都当 ERROR 打印纯属刷屏，降级成 debug
      if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) {
        log.debug(`${label} not supported by server`, { clientName })
      } else {
        log.error(`failed to get ${label}`, { clientName, error: e.message })
      }
      return e
    },
  }).pipe(
    Effect.map((items) => {
      const out: Record<string, T & { client: string }> = {}
      const sanitizedClient = sanitize(clientName)
      for (const item of items) {
        out[sanitizedClient + ":" + sanitize(item.name)] = { ...item, client: clientName }
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  creating: Set<string>
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly tools: () => Effect.Effect<Record<string, Tool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly resourceTemplates: () => Effect.Effect<Record<string, ResourceTemplateInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCP.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void>
  readonly disconnect: (name: string) => Effect.Effect<void>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (mcpName: string) => Effect.Effect<{ authorizationUrl: string; oauthState: string }>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const bus = yield* Bus.Service

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = (transport: Transport, timeout: number) =>
      Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = new Client({ name: "redcode", version: InstallationVersion })
              return withTimeout(client.connect(t), timeout).then(() => {
                // 260809 Red: MCP SDK send() 在 stdin backpressure（write 返回 false）时挂
                // once('drain')，子代理并行调用 MCP 工具会堆积 drain listener 超过默认上限，
                // Bun 触发 MaxListenersExceededWarning 并把整个 WriteStream 对象 inspect dump
                // 到 stderr，经 Worker stderr 继承污染 TUI 全屏（复现 .redcode/temp/repro-mcp-e2e.ts）。
                // _process 在 start() 后才存在，故在 connect 完成后设置。解除上限治本；
                // 兜底拦截在 worker.ts 的 process.on("warning")。
                if (t instanceof StdioClientTransport) {
                  ;(t as unknown as { _process: { stdin: NodeJS.WritableStream } })._process.stdin.setMaxListeners(0)
                }
                return client
              })
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "remote" },
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(key, mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
            },
          },
          auth,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              log.info("mcp server requires authentication", { key, transport: name })

              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                pendingOAuthTransports.set(key, transport)
                lastStatus = { status: "needs_auth" as const }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: redcode mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            log.debug("transport connection failed", {
              key,
              transport: name,
              url: mcp.url,
              error: lastError.message,
            })
            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.succeed(undefined)
          }),
        )
        if (result) {
          log.info("connected", { key, transport: result.transportName })
          return { client: result.client as MCPClient | undefined, status: { status: "connected" } as Status }
        }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command

      // 260607 Red cwd：如果 mcp 配置了 cwd，用它（支持 ~/ 和 $REDCODE_ROOT）；
      // 否则从 InstanceState.directory 向上找项目根
      const rawCwd = yield* InstanceState.directory
      let cwd = resolveMcpCwd(mcp.cwd, rawCwd)
      if (!mcp.cwd) {
        if (!fs.existsSync(path.join(cwd, "redcode.jsonc")) && !fs.existsSync(path.join(cwd, ".git"))) {
          let dir = cwd
          while (true) {
            const parent = path.dirname(dir)
            if (parent === dir) break
            dir = parent
            if (fs.existsSync(path.join(dir, "redcode.jsonc")) || fs.existsSync(path.join(dir, ".git"))) {
              cwd = dir
              break
            }
          }
        }
      }

      // 解析命令参数中的相对路径为绝对路径
      const resolvedArgs = args.map((arg) => {
        if (arg.startsWith("./") || arg.startsWith("../")) {
          return path.resolve(cwd, arg)
        }
        return arg
      })

      // 解析环境变量中的相对路径为绝对路径
      const resolvedEnv: Record<string, string | undefined> = { ...process.env }
      if (mcp.environment) {
        for (const [envKey, envValue] of Object.entries(mcp.environment)) {
          if (typeof envValue === "string" && (envValue.startsWith("./") || envValue.startsWith("../"))) {
            resolvedEnv[envKey] = path.resolve(cwd, envValue)
          } else {
            resolvedEnv[envKey] = envValue
          }
        }
      }

      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args: resolvedArgs,
        cwd,
        env: {
          ...resolvedEnv,
          ...(cmd === "redcode" ? { BUN_BE_BUN: "1" } : {}),
        },
      })
      // 260620 Red capture PID immediately — StdioClientTransport spawns in constructor,
      // but t.close() in acquireUseRelease release handler uses process.kill() which is
      // unreliable on Windows for compiled exes. We need the PID to killProcessTree on failure.
      const spawnedPid = transport.pid
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          log.error("local mcp startup failed", { key, command: mcp.command, cwd, error: msg })
          // 260620 Red kill orphaned process — without this, failed MCP servers become
          // orphans that accumulate on every reconnect/reconcile cycle (8+ copies observed).
          if (spawnedPid) {
            return killProcessTree(spawnedPid).pipe(
              Effect.andThen(Effect.succeed({ client: undefined, status: { status: "failed" as const, error: msg } })),
            )
          }
          return Effect.succeed({ client: undefined, status: { status: "failed" as const, error: msg } })
        }),
      )
    })

    // 260610 Red 移植上游 #31595(failure-safe)+#31544(actionable status)：
    //   外层 catchCause 让 create 永不 fail——任何意外抛错都收敛成 status:"failed"+错因，
    //   服务起不来时不再静默消失，状态栏能看到失败原因（之前 create 抛错被调用点 Effect.catch 吞掉=服务凭空消失）
    const create = Effect.fn("MCP.create")(
      function* (key: string, mcp: ConfigMCP.Info) {
        if (mcp.enabled === false) {
          log.info("mcp server disabled", { key })
          return DISABLED_RESULT
        }

        log.info("found", { key, type: mcp.type })

        const { client: mcpClient, status } =
          mcp.type === "remote"
            ? yield* connectRemote(key, mcp as ConfigMCP.Info & { type: "remote" })
            : yield* connectLocal(key, mcp as ConfigMCP.Info & { type: "local" })

        if (!mcpClient) {
          if (status.status !== "connected" && status.status !== "disabled") {
            log.warn("server unavailable", { key, type: mcp.type, status: status.status })
          }
          return { status } satisfies CreateResult
        }

        return yield* Effect.gen(function* () {
          const listed = yield* defs(key, mcpClient, mcp.timeout)
          if (!listed) {
            return yield* Effect.fail(new Error("Failed to get tools"))
          }
          log.info("create() successfully created client", { key, toolCount: listed.length })
          writeMcpToolsCache(key, listed)
          return { mcpClient, status, defs: listed } satisfies CreateResult
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
          ),
        )
      },
      Effect.map((result): CreateResult => result),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.succeed<CreateResult>({
          status: { status: "failed", error: error instanceof Error ? error.message : String(error) },
        })
      }),
    )
    const cfgSvc = yield* Config.Service

    const killProcessTree = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") {
          yield* spawner.spawn(ChildProcess.make("taskkill", ["/F", "/T", "/PID", String(pid)], { stdin: "ignore" })).pipe(
            Effect.ignore,
          )
          return
        }
        const pids: number[] = []
        const queue = [pid]
        while (queue.length > 0) {
          const current = queue.shift()!
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        for (const dpid of pids) {
          try {
            process.kill(dpid, "SIGTERM")
          } catch {}
        }
      },
      Effect.scoped,
      Effect.catch(() => Effect.void),
    )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log.info("tools list changed notification received", { server: name })
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(defs(name, client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = cfg.mcp ?? {}
        const s: State = {
          status: {},
          clients: {},
          defs: {},
          creating: new Set(),
        }

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                log.error("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              // 260610 Red 上游 #31595：create 已 failure-safe 永不 fail，去掉吞错的 Effect.catch
              const result = yield* create(key, mcp)
              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                watch(s, key, result.mcpClient, bridge, mcp.timeout)
              }
            }),
          { concurrency: "unbounded" },
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              Object.values(s.clients),
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    yield* killProcessTree(pid)
                  }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: "unbounded" },
            )
            pendingOAuthTransports.clear()
          }),
        )

        // 260603 Red P0: MCP 健康监控 — 每 30s 检查，连续 3 次失败标记断开
        const HEALTH_CHECK_INTERVAL = 30_000
        const MAX_FAILURES = 3
        const healthFailures = new Map<string, number>()

        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(HEALTH_CHECK_INTERVAL)
              const connected = Object.entries(s.clients).filter(
                ([name]) => s.status[name]?.status === "connected",
              )
              for (const [name, client] of connected) {
                try {
                  yield* Effect.tryPromise({
                    try: () => client.request({ method: "tools/list", params: {} }, ListToolsResultSchema),
                    catch: () => new Error("health check failed"),
                  })
                  healthFailures.delete(name)
                } catch {
                  const failures = (healthFailures.get(name) ?? 0) + 1
                  healthFailures.set(name, failures)
                  log.warn("MCP health check failed", { name, failures })
                  if (failures >= MAX_FAILURES) {
                    log.error("MCP server unhealthy, marking disconnected", { name })
                    healthFailures.delete(name)
                    yield* closeClient(s, name)
                    delete s.clients[name]
                    s.status[name] = { status: "failed", error: "health check failed" }
                  }
                }
              }
            }),
          ),
        )

        // 260603 Red 配置热重载：watch redcode.jsonc 自动触发 MCP 重连
        const mcpDir = yield* InstanceState.directory
        const cfgPath = path.join(mcpDir, "redcode.jsonc")
        if (fs.existsSync(cfgPath)) {
          let timer: ReturnType<typeof setTimeout> | null = null
          const reconcile = Effect.fnUntraced(function* () {
            const newCfg = yield* cfgSvc.get()
            const newMcps = newCfg.mcp ?? {}
            const currentNames = new Set(Object.keys(s.clients))

            for (const name of currentNames) {
              if (!newMcps[name] || newMcps[name]?.enabled === false) {
                yield* closeClient(s, name)
                delete s.clients[name]
                delete s.defs[name]
                s.status[name] = { status: "disabled" }
              }
            }
            for (const [name, mcp] of Object.entries(newMcps)) {
              if (!isMcpConfigured(mcp) || mcp.enabled === false) continue
              if (!s.clients[name]) {
                yield* createAndStore(name, mcp).pipe(Effect.catch(() => Effect.void))
              }
            }
          })
          const changeHandler: fs.WatchListener<string> = () => {
            if (timer) clearTimeout(timer)
            timer = setTimeout(async () => {
              timer = null
              try { await bridge.promise(reconcile()) } catch {}
            }, 1000)
          }
          const watcher = fs.watch(cfgPath, changeHandler)
          yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()))
        }

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.defs[name]
      if (!client) return Effect.void
      // 260607 Red 杀进程树：stdio server 不响应 stdin close 会变孤儿（gbrain/browsermcp 等）
      const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
        if (pid) yield* killProcessTree(pid)
      })
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      yield* closeClient(s, name)
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      watch(s, name, client, bridge, timeout)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCP.Info) {
      const s = yield* InstanceState.get(state)
      // 260620 Red prevent concurrent creation — without this guard, rapid reconcile/reconnect
      // calls spawn multiple processes for the same server before the first finishes connecting.
      if (s.creating.has(name)) {
        log.debug("createAndStore skipped — already creating", { name })
        return s.status[name] ?? { status: "failed" as const, error: "creation in progress" }
      }
      s.creating.add(name)
      try {
        const result = yield* create(name, mcp)
        s.status[name] = result.status
        if (!result.mcpClient) {
          yield* closeClient(s, name)
          delete s.clients[name]
          return result.status
        }
        // 260707 Red Windows: StdioClientTransport.close() waits for a 'close' event that
        // may never fire on Windows (SIGTERM/SIGKILL unreliable for console processes),
        // leaving the stdio subprocess alive and blocking process exit. Override close()
        // to killProcessTree first, then attempt the original close.
        if (process.platform === "win32") {
          const transport = result.mcpClient.transport
          if (transport instanceof StdioClientTransport) {
            const originalClose = transport.close.bind(transport)
            transport.close = async () => {
              const pid = transport.pid
              if (pid) {
                try { await Effect.runPromise(killProcessTree(pid)) } catch {}
              }
              try { await originalClose() } catch {}
            }
          }
        }
        return yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout)
      } finally {
        s.creating.delete(name)
      }
    })

    // 260603 Red P0+P1: 自动重连（使用 EffectBridge 不依赖 AppRuntime）
    const reconnectServer = Effect.fn("MCP.reconnectServer")(function* (name: string) {
      const cfg = yield* cfgSvc.get()
      const mcpCfg = cfg.mcp?.[name]
      if (!mcpCfg || !isMcpConfigured(mcpCfg) || mcpCfg.enabled === false) return
      log.info("auto-reconnecting MCP server", { name })
      yield* createAndStore(name, { ...mcpCfg, enabled: true }).pipe(Effect.catch(() => Effect.void))
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCP.Info) {
      yield* createAndStore(name, mcp)
      const s = yield* InstanceState.get(state)
      return { status: s.status }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* getMcpConfig(name)
      if (!mcp) {
        log.error("MCP config not found or invalid", { name })
        return
      }
      yield* createAndStore(name, { ...mcp, enabled: true })
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
    })

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, Tool> = {}
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) => s.status[clientName]?.status === "connected",
      )

      yield* Effect.forEach(
        connectedClients,
        ([clientName]) =>
          Effect.gen(function* () {
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : undefined

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("missing cached tools for connected server", { clientName })
              return
            }

            const timeout = entry?.timeout ?? defaultTimeout
            // 260603 Red P1: 用 EffectBridge 避免依赖 AppRuntime
            const toolBridge = yield* EffectBridge.make()
            const doReconnect = () => toolBridge.promise(reconnectServer(clientName))
            const disabled = entry?.type === "local" ? entry.disabledTools : undefined
            // 260807 Red: tools 白名单——只注入列出的工具，省略则全量（prefix 成本控制）
            const allow = entry?.tools
            for (const mcpTool of listed) {
              if (allow && !allow.includes(mcpTool.name)) continue
              if (disabled?.includes(mcpTool.name)) continue
              result[sanitize(clientName) + "_" + sanitize(mcpTool.name)] = convertMcpTool(
                // 260807 Red: 传 getClient 闭包而非 client 引用——s.clients[name] 重连后由 storeClient 换新
                mcpTool, () => s.clients[clientName], clientName, doReconnect, timeout,
              )
            }
          }),
        // 260623 Red sequential to stabilize tool insertion order for DeepSeek prefix cache
        { concurrency: 1 },
      )

      // 260620 Red cache-first: servers still starting/failed — fall back to disk cache
      const connectedNames = new Set(connectedClients.map(([n]) => n))
      for (const [serverName, cfgEntry] of Object.entries(config)) {
        if (!isMcpConfigured(cfgEntry) || cfgEntry.enabled === false) continue
        if (connectedNames.has(serverName)) continue

        const cached = readMcpToolsCache(serverName)
        if (!cached || cached.length === 0) continue

        log.info("using cached tools for MCP server", { serverName, toolCount: cached.length })
        const entry = cfgEntry
        const disabled = entry.type === "local" ? entry.disabledTools : undefined
        // 260807 Red: 与 live 路径同规则，白名单过滤后落盘工具
        const allow = entry.tools
        for (const mcpTool of cached) {
          if (allow && !allow.includes(mcpTool.name)) continue
          if (disabled?.includes(mcpTool.name)) continue
          result[sanitize(serverName) + "_" + sanitize(mcpTool.name)] = convertMcpToolCached(
            mcpTool, serverName,
          )
        }
      }

      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client) => Promise<T[]>,
      label: string,
    ) {
      return Effect.forEach(
        Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected"),
        ([clientName, client]) =>
          fetchFromClient(clientName, client, listFn, label).pipe(Effect.map((items) => Object.entries(items ?? {}))),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listPrompts().then((r) => r.prompts), "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listResources().then((r) => r.resources), "resources")
    })

    // 260624 Red 上游移植: MCP resource template listing
    const resourceTemplates = Effect.fn("MCP.resourceTemplates")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listResourceTemplates().then((r) => r.resourceTemplates), "resourceTemplates")
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient, timeout?: number) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        log.warn(`client not found for ${label}`, { clientName })
        return undefined
      }
      // 260610 Red 移植上游 #31612：给 getPrompt/readResource 也带上超时（之前无超时可永久挂起）
      const cfg = yield* cfgSvc.get()
      const configured = cfg.mcp?.[clientName]
      const timeout = (configured && isMcpConfigured(configured) ? configured.timeout : undefined) ?? cfg.experimental?.mcp_timeout ?? DEFAULT_TIMEOUT
      return yield* Effect.tryPromise({
        try: () => fn(client, timeout),
        catch: (e: any) => {
          log.error(`failed to ${label}`, { clientName, ...meta, error: e?.message })
          return e
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.getPrompt({ name, arguments: args }, { timeout }),
        "getPrompt",
        { promptName: name },
      )
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.readResource({ uri: resourceUri }, { timeout }),
        "readResource",
        { resourceUri },
      )
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) throw new Error(`MCP server ${mcpName} not found or disabled`)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpName, mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirectUri > callbackPort shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(url, { authProvider })

      return yield* Effect.tryPromise({
        try: () => {
          const client = new Client({ name: "redcode", version: InstallationVersion })
          return client
            .connect(transport)
            .then(() => ({ authorizationUrl: "", oauthState, client }) satisfies AuthResult)
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, transport)
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* getMcpConfig(mcpName)
        if (!mcpConfig) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "MCP config not found after auth" } as Status
        }

        const listed = client ? yield* defs(mcpName, client, mcpConfig.timeout) : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } as Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, mcpConfig.timeout)
      }

      log.info("opening browser for oauth", { mcpName, url: result.authorizationUrl, state: result.oauthState })

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          log.warn("failed to open browser, user must open URL manually", { mcpName })
          return bus.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      const transport = pendingOAuthTransports.get(mcpName)
      if (!transport) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          log.error("failed to finish oauth", { mcpName, error })
          return error
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } as Status
      }

      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return { status: "failed", error: "MCP config not found after auth" } as Status

      return yield* createAndStore(mcpName, mcpConfig)
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
      log.info("removed oauth credentials", { mcpName })
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return false
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated" as AuthStatus
      const expired = yield* auth.isTokenExpired(mcpName)
      return (expired ? "expired" : "authenticated") as AuthStatus
    })

    return Service.of({
      status,
      clients,
      tools,
      prompts,
      resources,
      resourceTemplates,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.layer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as MCP from "."
