import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@redcode-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  REDCODE_SERVER_PASSWORD: Flag.REDCODE_SERVER_PASSWORD,
  REDCODE_SERVER_USERNAME: Flag.REDCODE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.REDCODE_SERVER_PASSWORD = original.REDCODE_SERVER_PASSWORD
  Flag.REDCODE_SERVER_USERNAME = original.REDCODE_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.REDCODE_SERVER_PASSWORD = undefined
    Flag.REDCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the redcode username", () => {
    Flag.REDCODE_SERVER_PASSWORD = "secret"
    Flag.REDCODE_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("redcode:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.REDCODE_SERVER_PASSWORD = "secret"
    Flag.REDCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.REDCODE_SERVER_PASSWORD = "secret"
    Flag.REDCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "redcode", password: Redacted.make("secret") }, config)).toBe(false)
  })
})
