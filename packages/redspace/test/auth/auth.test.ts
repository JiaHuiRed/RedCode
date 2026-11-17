import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

// 261015 Red 审计 A07：REDCODE_AUTH_CONTENT 的**结构**校验。此前只做 JSON.parse + as 断言，
// 于是合法 JSON 里的 null / [] / 0 / {"openai":1} 都被冒充成 Record<string, Info> 返回 ——
// `null` 那种还会让调用方的 (...)[providerID] 当场抛。这里直调纯函数，不动进程环境。
describe("parseEnvAuthContent", () => {
  test("合法覆盖值：api / wellknown / oauth 三种都能解出来", () => {
    const out = Auth.parseEnvAuthContent(
      JSON.stringify({
        anthropic: { type: "api", key: "sk-test" },
        "https://example.com": { type: "wellknown", key: "TOKEN", token: "abc" },
        openai: { type: "oauth", refresh: "r", access: "a", expires: 0 },
      }),
    )
    expect(Object.keys(out!)).toEqual(["anthropic", "https://example.com", "openai"])
    expect(out!.anthropic?.type).toBe("api")
  })

  test("语法错误返回 undefined（回落磁盘凭据）", () => {
    expect(Auth.parseEnvAuthContent("{not json")).toBeUndefined()
  })

  test("合法 JSON 但不是普通对象：一律拒绝", () => {
    for (const bad of ["null", "[]", "0", '"str"', "true"]) {
      expect(Auth.parseEnvAuthContent(bad)).toBeUndefined()
    }
  })

  test("取值类型非法：整体拒绝，不做半套应用", () => {
    expect(Auth.parseEnvAuthContent(JSON.stringify({ openai: 1 }))).toBeUndefined()
    expect(Auth.parseEnvAuthContent(JSON.stringify({ openai: { type: "nope" } }))).toBeUndefined()
    expect(
      Auth.parseEnvAuthContent(JSON.stringify({ openai: { type: "api", key: "sk" }, bad: 1 })),
    ).toBeUndefined()
  })

  test("空对象合法（等于不提供凭据）", () => {
    expect(Auth.parseEnvAuthContent("{}")).toEqual({})
  })
})

describe("Auth", () => {
  it.live("set normalizes trailing slashes in keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeDefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set cleans up pre-existing trailing-slash entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "old",
        })
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "new",
        })
        const data = yield* auth.all()
        const keys = Object.keys(data).filter((key) => key.includes("example.com"))
        expect(keys).toEqual(["https://example.com"])
        const entry = data["https://example.com"]!
        expect(entry.type).toBe("wellknown")
        if (entry.type === "wellknown") expect(entry.token).toBe("new")
      }),
    ),
  )

  it.live("remove deletes both trailing-slash and normalized keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        yield* auth.remove("https://example.com/")
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeUndefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set and remove are no-ops on keys without trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", {
          type: "api",
          key: "sk-test",
        })
        const data = yield* auth.all()
        expect(data["anthropic"]).toBeDefined()
        yield* auth.remove("anthropic")
        const after = yield* auth.all()
        expect(after["anthropic"]).toBeUndefined()
      }),
    ),
  )
})
