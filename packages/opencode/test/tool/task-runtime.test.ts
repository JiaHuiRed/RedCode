import { describe, expect, test } from "bun:test"
import {
  boundedResultProjection,
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

  test("keeps runtime verification facts separate from child claims", () => {
    const result = {
      status: "ready_for_review",
      summary: "Inspected the provider path",
      requestedScope: [],
      uncertainties: [],
      changedFiles: [],
      verification: [{ command: "bun dev models", status: "passed", output: "model listed" }],
      toolCalls: 4,
      elapsedMs: 1200,
      termination: "normal",
    } as const

    expect(Schema.is(ResultPacketSchema)(result)).toBe(true)
    expect(result.status).not.toBe("completed")
  })

  test("creates an honest result when runtime has not run verification", () => {
    const result = createChildResultPacket({
      packet: validPacket,
      status: "ready_for_review",
      summary: "Inspected the provider path",
      elapsedMs: 1200,
      termination: "normal",
    })

    expect(result.toolCalls).toBeUndefined()
    expect(result.verification).toEqual([
      { command: "Run a read-only model listing", status: "not_run", output: "" },
    ])
    expect(result.uncertainties).toHaveLength(1)
  })

  test("caps the Main projection and records truncation", () => {
    const result = {
      status: "ready_for_review",
      summary: "x".repeat(100_000),
      requestedScope: ["packages/opencode".repeat(100)],
      uncertainties: [],
      changedFiles: [],
      verification: [{ command: "bun test", status: "passed", output: "ok" }],
      toolCalls: 4,
      elapsedMs: 1200,
      termination: "normal",
    } as const

    const projection = boundedResultProjection(result)
    expect(projection.truncated).toBe(true)
    expect(projection.originalBytes).toBeGreaterThan(MAX_MAIN_PROJECTION_BYTES)
    expect(new TextEncoder().encode(projection.text).byteLength).toBeLessThanOrEqual(MAX_MAIN_PROJECTION_BYTES)
    expect(JSON.parse(projection.text).truncated).toBe(true)
  })
})
