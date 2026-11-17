import { describe, expect, test } from "bun:test"
import { mergeConfigText, parseConfig } from "../../../../script/merge-home-config"

describe("mergeConfigText", () => {
  test("adds missing keys without touching existing comments", () => {
    const raw = `{
  // keep this note
  "model": "a/b"
}
`
    const patched = mergeConfigText(raw, `{ "model": "a/b", "theme": "dark" }`)

    expect(patched).toContain("// keep this note")
    expect(parseConfig(patched)).toEqual({ model: "a/b", theme: "dark" })
  })

  test("keeps a single-line object with a block comment intact", () => {
    const raw = `{ "a": 1 /* keep */ }`
    const patched = mergeConfigText(raw, `{ "a": 1, "b": 2 }`)

    // 修复前手写扫描器在这里不跳块注释，会把新键插进 /* ... */ 里面。
    expect(patched).toContain("/* keep */")
    expect(parseConfig(patched)).toEqual({ a: 1, b: 2 })
  })

  test("is idempotent", () => {
    const raw = `{ "a": 1 }`
    const template = `{ "a": 1, "b": 2 }`

    const once = mergeConfigText(raw, template)
    expect(mergeConfigText(once, template)).toBe(once)
  })

  test("keeps user values when the template disagrees", () => {
    const patched = mergeConfigText(`{ "model": "user/model" }`, `{ "model": "template/model", "theme": "dark" }`)

    expect(parseConfig(patched)).toEqual({ model: "user/model", theme: "dark" })
  })

  test("local layer shadows template keys", () => {
    const patched = mergeConfigText(`{ "a": 1 }`, `{ "a": 1, "ollama": { "enabled": true } }`, { ollama: {} })

    expect(parseConfig(patched)).toEqual({ a: 1 })
  })

  test("reports invalid jsonc instead of silently dropping it", () => {
    expect(() => mergeConfigText("{ broken", "{}")).toThrow()
  })
})
