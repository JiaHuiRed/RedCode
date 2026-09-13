import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isUsableLanAddress, resolveLanDefaultPassword } from "../../src/cli/network"

const KEY = "REDCODE_SERVER_PASSWORD"
let saved: string | undefined

beforeEach(() => {
  saved = process.env[KEY]
  delete process.env[KEY]
})

afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

describe("cli.network", () => {
  test("skips docker, link-local and benchmark ranges", () => {
    expect(isUsableLanAddress("172.17.0.1")).toBe(false)
    expect(isUsableLanAddress("169.254.67.164")).toBe(false)
    expect(isUsableLanAddress("198.18.0.1")).toBe(false)
    expect(isUsableLanAddress("198.19.5.5")).toBe(false)
  })

  test("keeps real LAN addresses", () => {
    expect(isUsableLanAddress("192.168.1.3")).toBe(true)
    expect(isUsableLanAddress("10.0.0.5")).toBe(true)
    expect(isUsableLanAddress("100.64.0.7")).toBe(true)
  })

  test("leaves loopback bindings without a password", () => {
    resolveLanDefaultPassword("127.0.0.1")
    expect(process.env[KEY]).toBeUndefined()
    resolveLanDefaultPassword("localhost")
    expect(process.env[KEY]).toBeUndefined()
  })

  test("injects the built-in password for exposed bindings", () => {
    resolveLanDefaultPassword("0.0.0.0")
    expect(process.env[KEY]).toBe("RedCode0429")
  })

  test("keeps an explicit password untouched", () => {
    process.env[KEY] = "mine:with:colons"
    resolveLanDefaultPassword("0.0.0.0")
    expect(process.env[KEY]).toBe("mine:with:colons")
  })

  test("keeps an explicitly blank password (means: no auth, on purpose)", () => {
    process.env[KEY] = ""
    resolveLanDefaultPassword("0.0.0.0")
    expect(process.env[KEY]).toBe("")
  })
})
