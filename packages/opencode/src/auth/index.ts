import path from "path"
import { Effect, Layer, Option, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@redcode-ai/core/schema"
import { Global } from "@redcode-ai/core/global"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import * as Log from "@redcode-ai/core/util/log"

const log = Log.create({ service: "auth" })

export const OAUTH_DUMMY_KEY = "redcode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

/**
 * 261015 Red 解析 REDCODE_AUTH_CONTENT 覆盖值（审计 A07）。
 *
 * 返回 undefined 表示「这份覆盖值不可用」，调用方据此回落到磁盘凭据。
 * 放在 Effect 外的普通 helper 里有两层原因：① 本包明文禁止在 Effect.gen 内写 try/catch；
 * ② all() 的契约是 `Record<string, Info>`，把解析留在 Effect 管道外才保得住那个推断类型
 * （塞进管道会让成功类型塌成别的联合，连带打崩 set/remove 里的索引访问）。
 *
 * 导出只为让测试直接驱动（纯函数、参数化，不动进程环境）——与文件路径共用同一个 Info 解码。
 */
export function parseEnvAuthContent(content: string): Record<string, Info> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // 261015 Red 语法错必须响：静默吞掉会让「设了 REDCODE_AUTH_CONTENT 却没生效」查不出来
    // （AGENTS.md：误配置要响）。
    log.warn("REDCODE_AUTH_CONTENT is not valid JSON, falling back to stored credentials")
    return undefined
  }
  // 261015 Red 合法 JSON ≠ 合法凭据：顶层必须是普通对象、每项必须解得出 Oauth/Api/WellKnown。
  // 此前直接 `as Record<string, Info>`，于是 `null` / `[]` / `0` / `{"openai":1}` 都被冒充成凭据
  // 返回 —— `null` 那种还会让调用方的 `(...)[providerID]` 当场抛。任一项不合法就整体忽略这次覆盖
  // （凭据不做半套应用），warn 只报键名：值里可能有密钥。
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log.warn("REDCODE_AUTH_CONTENT rejected: expected a provider→credential object", { keys: authKeys(parsed) })
    return undefined
  }
  const decoded = decodeAuthRecord(parsed)
  if (Option.isSome(decoded)) return decoded.value
  log.warn("REDCODE_AUTH_CONTENT rejected: provider entries must be valid credentials", { keys: authKeys(parsed) })
  return undefined
}

/** warn 用的安全投影：只取顶层键名，不含任何值。 */
function authKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  return Object.keys(value).slice(0, 10)
}

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

// 261015 Red 环境覆盖值与磁盘 auth.json 用**同一个**解码口径：值是 Schema 类实例，与文件路径
// (`decode(value)`) 产出的形状一致，set() 写回磁盘时序列化行为也一致。
const decodeAuthRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Info))

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      const content = process.env.REDCODE_AUTH_CONTENT
      if (content) {
        const fromEnv = parseEnvAuthContent(content)
        if (fromEnv !== undefined) return fromEnv
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
