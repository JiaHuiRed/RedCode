import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@redcode-ai/core/schema"
import { Global } from "@redcode-ai/core/global"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import * as Log from "@redcode-ai/core/util/log"

const log = Log.create({ service: "auth" })

export const OAUTH_DUMMY_KEY = "redcode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

/**
 * 261015 Red 解析 REDCODE_AUTH_CONTENT 覆盖值。
 *
 * 返回 undefined 表示「不是合法 JSON，别用它」，调用方据此回落到磁盘凭据。
 * 放在 Effect 外的普通 helper 里有两层原因：① 本包明文禁止在 Effect.gen 内写 try/catch；
 * ② all() 的契约是 `Record<string, Info>`，把解析留在 Effect 管道外才保得住那个推断类型
 * （塞进管道会让成功类型塌成别的联合，连锁打崩 set/remove 里的索引访问）。
 */
function parseEnvAuthContent(content: string): Record<string, Info> | undefined {
  try {
    return JSON.parse(content) as Record<string, Info>
  } catch {
    // 261015 Red 非法 JSON 必须响：静默吞掉会让「设了 REDCODE_AUTH_CONTENT 却没生效」查不出来
    // （AGENTS.md：误配置要响）。环境变量的内容本来就没经过校验，与改动前返回 JSON.parse 原值一致。
    log.warn("REDCODE_AUTH_CONTENT is not valid JSON, falling back to stored credentials")
    return undefined
  }
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
