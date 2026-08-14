import path from "path"
import { execFileSync } from "child_process"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { AppFileSystem } from "./filesystem"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const USER_AGENT = `RedCode/${InstallationChannel}/${InstallationVersion}/${Flag.REDCODE_CLIENT}`

// 260731 Karina 运行时也复用 git 的代理配置，跟构建脚本（opencode/script/generate.ts）同源。
//
// 起因：从 `redcode.cmd`（bun 装的 wrapper，源码跑）启动时 provider 全挂，报的是
// "2 of 5 requests failed … config.providers, provider.list"，日志里只有一句
// "Failed to fetch models.dev"。而双击 exe 却正常 —— 因为编译产物里烤了
// REDCODE_MODELS_DEV 快照，源码跑没有，落到网络取数就直连超时了。
// 这台机器的代理只配在 git 里（http.proxy），环境变量一个都没有：git push 通、
// 运行时取数不通。构建脚本 0.8.1 已经这么修过一次，运行时没跟上。
//
// 只读 git 配置，不写；只作用于 models.dev 这一个请求，**不改全局 env** ——
// 否则会把 Ollama 这类本地 provider 的请求也一起代理掉。
// Bun 的 fetch 认 init.proxy，Node 的会忽略未知字段（等于不生效，行为与改前一致）。
function gitProxy(): string | undefined {
  for (const key of ["https.proxy", "http.proxy"]) {
    try {
      const value = execFileSync("git", ["config", "--get", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      if (value) return value
    } catch {
      // 没配这一项，或者根本没有 git —— 都不是错误，继续试下一个
    }
  }
  return undefined
}

// 环境变量优先：用户显式设了就不该被 git 配置盖掉
const ENV_PROXY = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some(
  (key) => process.env[key],
)

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  // models.dev 对推理控制的声明式描述（effort 档位集合 / thinking 开关 / budget_tokens 区间）。
  // 外部数据、形态会演化（上游收紧成 typed union 后又被真实数据逼着拓宽过一轮），
  // 这里按 Json 透传不收紧结构，运行时收窄在 opencode/provider/transform 的消费端做。
  reasoning_options: Schema.optional(Schema.MutableJson),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export const Event = {
  Refreshed: EventV2.define({
    type: "models-dev.refreshed",
    schema: {},
  }),
}

declare const REDCODE_MODELS_DEV: Record<string, Provider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@RedCode/ModelsDev") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )
    // 没有环境变量代理、但 git 里配了的话，models.dev 这个请求单独走它
    const proxy = ENV_PROXY ? undefined : gitProxy()

    const source = Flag.REDCODE_MODELS_URL || "https://models.dev"
    const filepath = path.join(
      Global.Path.cache,
      source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const ttl = Duration.minutes(5)
    const lockKey = `models-dev:${filepath}`

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      // 代理路径实测比直连慢不少（本机走 7897 拉这 3MB 要 20s 上下），
      // 沿用构建脚本的口径给足超时，别让它半路断掉
      if (proxy)
        return yield* Effect.tryPromise(() =>
          fetch(`${source}/api.json`, {
            headers: { "User-Agent": USER_AGENT },
            proxy,
            signal: AbortSignal.timeout(90_000),
          } as RequestInit).then((res) => {
            if (!res.ok) throw new Error(`models.dev responded ${res.status}`)
            return res.text()
          }),
        )
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const loadFromDisk = fs.readJson(Flag.REDCODE_MODELS_PATH ?? filepath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    const loadSnapshot = Effect.sync(() =>
      typeof REDCODE_MODELS_DEV === "undefined" ? undefined : REDCODE_MODELS_DEV,
    )

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      yield* fs.writeWithDirs(filepath, text)
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (Flag.REDCODE_DISABLE_MODELS_FETCH) return {}
      // Flock is cross-process: concurrent RedCode CLIs can race on this cache file.
      const text = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          return yield* fetchAndWrite()
        }),
      )
      return JSON.parse(text) as Record<string, Provider>
    }).pipe(
      Effect.withSpan("ModelsDev.populate"),
      // 260731 Karina 取不到模型目录不该把整个 provider 层带崩。
      // 原来是 orDie —— 取数超时直接变成 defect，顶层只剩一句
      // "2 of 5 requests failed: Unexpected server error… config.providers, provider.list"，
      // 完全看不出是网络问题。models.dev 只是模型目录，取不到就降级成空目录：
      // 已配好的 provider 照常能用，只是模型列表空着，并打一条说清怎么办的 warning。
      Effect.catchCause((cause) =>
        Effect.logWarning(
          [
            `取不到模型目录（${source}/api.json），本次以空目录启动 —— 模型列表会是空的。`,
            proxy
              ? `已尝试经 git 配置的代理 ${proxy}。`
              : `未检测到代理配置：若本机需要代理出网，设一个 HTTPS_PROXY 环境变量，或 git config --global http.proxy <地址>（只读取、不修改）。`,
            `也可以先跑 \`redcode models --refresh\` 把目录缓存到 ${filepath}。`,
          ].join("\n"),
        ).pipe(
          Effect.annotateLogs("cause", String(cause)),
          Effect.as({} as Record<string, Provider>),
        ),
      ),
    )

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) =>
          Effect.logError("Failed to fetch models.dev").pipe(Effect.annotateLogs("cause", cause)),
        ),
        Effect.ignore,
      )
    })

    if (!Flag.REDCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
)

export * as ModelsDev from "./models-dev"
