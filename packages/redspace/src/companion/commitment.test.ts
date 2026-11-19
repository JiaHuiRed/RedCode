import { describe, expect, test } from "bun:test"
import { MAX_TEXT_BYTES, MIN_DELAY_MS, parse, validate } from "./commitment"

const now = Date.parse("2026-11-19T10:00:00.000Z")
const future = "2026-11-19T12:00:00.000Z"

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    itemId: "i1",
    kind: "event_check_in",
    sensitivity: "routine",
    source: "inferred_user_context",
    suggestedText: "面试怎么样了？",
    reason: "用户提到今天有面试",
    dedupeKey: "interview:2026-11-19",
    confidence: 0.8,
    dueWindow: { earliest: future },
    ...overrides,
  }
}

describe("commitment.parse", () => {
  test("reads a plain candidates array", () => {
    const parsed = parse(JSON.stringify({ candidates: [candidate()] }))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.kind).toBe("event_check_in")
  })

  test("accepts a fenced json block", () => {
    const parsed = parse("```json\n" + JSON.stringify({ candidates: [candidate()] }) + "\n```")
    expect(parsed).toHaveLength(1)
  })

  test("drops malformed and skipped candidates", () => {
    const parsed = parse(
      JSON.stringify({
        candidates: [candidate({ kind: "nope" }), candidate({ action: "skip" }), candidate({ suggestedText: "" })],
      }),
    )
    expect(parsed).toHaveLength(0)
  })

  test("truncates text by bytes", () => {
    const parsed = parse(JSON.stringify({ candidates: [candidate({ suggestedText: "你".repeat(1000) })] }))
    expect(Buffer.byteLength(parsed[0]!.text)).toBeLessThanOrEqual(MAX_TEXT_BYTES)
  })

  test("returns empty on bad json", () => {
    expect(parse("not json")).toHaveLength(0)
  })
})

describe("commitment.validate", () => {
  test("clamps the due time to the minimum delay", () => {
    const due = new Date(now + 60_000).toISOString()
    const valid = validate({ candidates: parse(JSON.stringify({ candidates: [candidate({ dueWindow: { earliest: due } })] })), nowMs: now })
    expect(valid).toHaveLength(1)
    expect(valid[0]?.earliestMs).toBe(now + MIN_DELAY_MS)
  })

  test("rejects past due windows and low confidence", () => {
    const past = new Date(now - 60_000).toISOString()
    const candidates = parse(
      JSON.stringify({
        candidates: [
          candidate({ dueWindow: { earliest: past } }),
          candidate({ confidence: 0.2 }),
          candidate({ sensitivity: "care", confidence: 0.6 }),
        ],
      }),
    )
    expect(validate({ candidates, nowMs: now })).toHaveLength(0)
  })

  test("defaults latest to a bounded window", () => {
    const valid = validate({ candidates: parse(JSON.stringify({ candidates: [candidate()] })), nowMs: now })
    expect(valid[0]?.latestMs).toBe(valid[0]!.earliestMs + 12 * 60 * 60 * 1000)
  })
})
