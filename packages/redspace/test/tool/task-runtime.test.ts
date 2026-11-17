import { describe, expect, test } from "bun:test"
import {
  boundedTaskText,
  compileExploreTaskPacket,
  createChildResultPacket,
  decodeTaskPacket,
  MAX_MAIN_PROJECTION_BYTES,
  ResultPacketSchema,
  TaskPacketSchema,
} from "../../src/tool/task-runtime"
import { Schema } from "effect"

const validPacket = {
  version: 1,
  goal: "Inspect the provider resolution path",
  profile: "explore",
  scope: {
    directories: ["packages/opencode/src/provider"],
    files: [],
  },
  constraints: ["Do not modify files"],
  acceptance: ["Explain why the model is not listed"],
  verification: ["Run a read-only model listing"],
  return: "Return file references and evidence",
} as const

describe("child task runtime contract", () => {
  test("decodes a complete task packet", () => {
    expect(decodeTaskPacket(validPacket)).toEqual(validPacket)
  })

  test("compiles the first explore profile with a bounded directory scope", () => {
    expect(compileExploreTaskPacket({ goal: validPacket.goal, directory: "packages/opencode" })).toMatchObject({
      profile: "explore",
      scope: { directories: ["packages/opencode"], files: [] },
    })
  })

  test("rejects packets without bounded scope or acceptance", () => {
    expect(
      decodeTaskPacket({
        ...validPacket,
        scope: { directories: [], files: [] },
      }),
    ).toBeUndefined()
    expect(
      decodeTaskPacket({
        ...validPacket,
        acceptance: [],
      }),
    ).toBeUndefined()
  })

  test("does not expose a completed result status", () => {
    expect(Schema.is(ResultPacketSchema)({ ...validPacket, status: "completed" })).toBe(false)
  })

  test("rejects malformed packets before child execution", () => {
    expect(decodeTaskPacket({ ...validPacket, profile: "unknown" })).toBeUndefined()
    expect(decodeTaskPacket({ ...validPacket, goal: "   " })).toBeUndefined()
  })

  test("accepts an honest result without fabricated runtime fields", () => {
    const result = {
      status: "ready_for_review",
      summary: "Inspected the provider path",
      requestedScope: [],
      uncertainties: [],
      elapsedMs: 1200,
      termination: "normal",
    }

    expect(Schema.is(ResultPacketSchema)(result)).toBe(true)
    expect(result.status).not.toBe("completed")
  })

  test("creates an honest result without fabricated verification rows", () => {
    const result = createChildResultPacket({
      packet: validPacket,
      status: "ready_for_review",
      summary: "Inspected the provider path",
      elapsedMs: 1200,
      termination: "normal",
    })

    expect(result.requestedScope).toEqual(["packages/opencode/src/provider"])
    expect(result.uncertainties).toEqual(["Runtime did not independently execute Task Packet verification."])
    expect("changedFiles" in result).toBe(false)
    expect("verification" in result).toBe(false)
    expect("toolCalls" in result).toBe(false)
  })

  test("caps the Main projection and truncates on byte boundaries", () => {
    const big = boundedTaskText("x".repeat(100_000))
    expect(new TextEncoder().encode(big).byteLength).toBeLessThanOrEqual(MAX_MAIN_PROJECTION_BYTES)
    expect(big).toContain("[truncated: showing first ")

    // 截断点落在 CJK 多字节字符中间：回退到字符边界，不出 U+FFFD
    // "x"×32636 + "中"×50 = 32786 字节 > 32KB；帽沿 32640 落在第 2 个「中」的续字节上
    const cjk = "x".repeat(32_636) + "中".repeat(50)
    const cut = boundedTaskText(cjk)
    expect(cut.split("中").length - 1).toBe(1)
    expect(cut).not.toContain("\uFFFD")
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(MAX_MAIN_PROJECTION_BYTES)
  })
})
