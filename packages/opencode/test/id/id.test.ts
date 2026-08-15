import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

// 260814 Red 64 位扩容回归：旧 6 字节(48 位)编码回绕周期 2^36 ms ≈ 795 天，
// 2026-08-14 19:19:55.136 第 26 次回绕后 ID 字典序不再单调。扩容后 2^52 ms（约 14 万年）内不回绕。
describe("id.64bit", () => {
  test("ascending id is 30 chars (16 hex + 14 random) plus prefix", () => {
    const id = Identifier.ascending("message")
    expect(id).toMatch(/^msg_[0-9a-f]{16}[0-9A-Za-z]{14}$/)
    expect(id.length).toBe(3 + 1 + 30)
  })

  test("timestamp round-trips through 64-bit encoding", () => {
    const t = Date.now()
    const id = Identifier.create("msg", "ascending", t)
    expect(Identifier.timestamp(id)).toBe(t)
  })

  test("timestamp() still decodes legacy 48-bit ids", () => {
    // 回绕现场真实 ID（19:18:23 生成，编码值已被 48 位截断，解码出的是回绕后的假时间戳）
    const legacy = "msg_ffffe99de001q1YxL03nJcwemG"
    expect(Identifier.timestamp(legacy)).toBe(0xffffe99de)
  })

  test("same-ms ids stay lexicographically ordered (counter tie-break)", () => {
    const t = 1_786_706_395_000
    const a = Identifier.create("msg", "ascending", t)
    const b = Identifier.create("msg", "ascending", t)
    const c = Identifier.create("msg", "ascending", t)
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })

  test("no 48-bit wrap: id encodes the full timestamp window", () => {
    // 旧编码在 2026-08-14 19:19:55.136 回绕，新编码该时刻前后仍严格单调
    const t1 = 1_786_706_395_136 - 1_000 // 回绕点前 1s
    const t2 = 1_786_706_395_136 + 1_000 // 回绕点后 1s
    const before = Identifier.create("msg", "ascending", t1)
    const after = Identifier.create("msg", "ascending", t2)
    expect(before < after).toBe(true)
    expect(Identifier.timestamp(before)).toBe(t1)
    expect(Identifier.timestamp(after)).toBe(t2)
  })

  test("descending ids stay inversely ordered", () => {
    const t = Date.now()
    const a = Identifier.create("msg", "descending", t)
    const b = Identifier.create("msg", "descending", t)
    expect(a > b).toBe(true)
  })
})
