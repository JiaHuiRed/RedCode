import { describe, expect, test } from "bun:test"
import { internalTranscripts, transcript, transcriptPath } from "@/companion/transcript"

const message = (role: string, content: unknown, extra = {}) =>
  JSON.stringify({
    type: "message",
    timestamp: "2026-11-16T08:00:00Z",
    message: { role, content, ...extra },
  })

describe("OpenClaw transcript import", () => {
  test("retains original paragraphs and role/time/source attribution without tools or reasoning", async () => {
    const raw = [
      JSON.stringify({ type: "session", id: "old" }),
      message("user", [{ type: "text", text: "I chose silver thread.\n\nIt reminds me of home." }]),
      message("assistant", [
        { type: "thinking", thinking: "PRIVATE_REASONING" },
        { type: "text", text: "We can keep that detail." },
        { type: "toolCall", name: "read", arguments: { secret: "PRIVATE_ARGUMENT" } },
      ]),
      message("toolResult", [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }]),
      JSON.stringify({ type: "compaction", summary: "DERIVED_SUMMARY" }),
      message("assistant", "SYNTHETIC_SUMMARY", { summary: true }),
    ].join("\n")
    const result = await transcript(raw, "agents/main/sessions/old.jsonl")
    expect(result.invalid).toBe(0)
    expect(result.humanTurns).toBe(1)
    expect(result.extracted).toBe(2)
    expect(result.internal).toBe(false)
    expect(result.text).toContain("Source: agents/main/sessions/old.jsonl")
    expect(result.text).toContain("User | 2026-11-16T08:00:00.000Z | JSONL line 2")
    expect(result.text).toContain("I chose silver thread.\n\nIt reminds me of home.")
    expect(result.text).toContain("Assistant | 2026-11-16T08:00:00.000Z | JSONL line 3")
    for (const excluded of [
      "PRIVATE_REASONING",
      "PRIVATE_ARGUMENT",
      "PRIVATE_TOOL_OUTPUT",
      "DERIVED_SUMMARY",
      "SYNTHETIC_SUMMARY",
    ])
      expect(result.text).not.toContain(excluded)
  })

  test("does not turn internal user-role events and their assistant responses into shared experiences", async () => {
    const prompts = [
      "[cron:job-id] generated work",
      "[Inter-session message] sourceTool=image_generate isUser=false",
      "Read HEARTBEAT.md if it exists (workspace context). If nothing needs attention, reply HEARTBEAT_OK.",
      "[OpenClaw heartbeat poll]",
      "Pre-compaction memory flush. Store durable memories only in memory/YYYY-MM-DD.md.",
      "System: [2026-11-16] background task complete",
      "OpenClaw runtime event. internal content",
    ]
    for (const prompt of prompts) {
      const result = await transcript(
        [
          message("user", prompt),
          message("assistant", "INTERNAL_RESULT"),
          message("user", "A real conversation begins here."),
          message("assistant", "A real reply."),
        ].join("\n"),
        "old.jsonl",
      )
      expect(result.text).not.toContain("INTERNAL_RESULT")
      expect(result.text).toContain("A real conversation begins here.")
      expect(result.text).toContain("A real reply.")
    }
    expect(
      (
        await transcript(
          [
            message("user", "Looks like normal text", { provenance: { kind: "inter_session" } }),
            message("assistant", "INTERNAL_RESULT"),
          ].join("\n"),
          "old.jsonl",
        )
      ).text,
    ).toBe("")
    for (const sessionKey of ["agent:main:cron:job", "agent:main:subagent:child", "dreaming-narrative-run-1"]) {
      const internal = await transcript(
        [message("user", "not a human message"), JSON.stringify({ type: "custom", data: { sessionKey } })].join("\n"),
        "old.jsonl",
      )
      expect(internal.text).toBe("")
      expect(internal.internal).toBe(true)
    }
  })

  test("strips recognized envelopes and reports broken records without inventing missing turns", async () => {
    const raw = [
      message(
        "user",
        'Conversation info (untrusted metadata):\n```json\n{"private":"TRANSPORT_DATA"}\n```\n[Mon 2026-11-16 16:00 GMT+8] The original sentence.\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nINTERNAL_CONTEXT\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
      ),
      "{broken",
      message("assistant", "ORPHAN_REPLY"),
      message("user", "Later intact sentence."),
      message("assistant", "NO_REPLY"),
    ].join("\n")
    const result = await transcript(raw, "old.jsonl")
    expect(result.invalid).toBe(1)
    expect(result.text).toContain("The original sentence.")
    expect(result.text).toContain("Later intact sentence.")
    for (const value of ["TRANSPORT_DATA", "INTERNAL_CONTEXT", "ORPHAN_REPLY", "NO_REPLY"])
      expect(result.text).not.toContain(value)
  })

  test("uses agent scope and skips deleted, checkpoint, trajectory and backup files", () => {
    expect(transcriptPath("agents/main/sessions/abc.jsonl", "main")).toBe(true)
    expect(transcriptPath("agents/main/sessions/abc.jsonl.reset.2026-11-16", "main")).toBe(true)
    for (const file of [
      "agents/dev/sessions/abc.jsonl",
      "agents/main/sessions/abc.trajectory.jsonl",
      "agents/main/sessions/abc.jsonl.deleted.2026",
      "agents/main/sessions/abc.compaction-checkpoint.jsonl",
      "agents/main/sessions/abc.jsonl.bak.2026",
    ])
      expect(transcriptPath(file, "main")).toBe(false)
    expect([
      ...internalTranscripts(
        JSON.stringify({
          "agent:main:main": { sessionId: "real" },
          "agent:main:main:heartbeat": { sessionFile: "C:\\old\\tick.jsonl" },
          "agent:main:cron:job": { sessionId: "cron" },
        }),
      ),
    ]).toEqual(["tick", "cron"])
  })
})
