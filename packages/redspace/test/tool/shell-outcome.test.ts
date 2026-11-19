import { describe, expect, test } from "bun:test"
import { outcomeNotes } from "../../src/tool/shell"

describe("shell outcome notes", () => {
  test("interruption reports unknown outcome and asks to verify", () => {
    const notes = outcomeNotes({ aborted: true, expired: false, timeout: 120000 })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("exit status is unknown")
    expect(notes[0]).toContain("may still be running")
    expect(notes[0]).toContain("verify")
  })

  test("timeout warns about leftover side effects", () => {
    const notes = outcomeNotes({ aborted: false, expired: true, timeout: 1000 })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("exceeding timeout 1000 ms")
    expect(notes[0]).toContain("side effects")
    expect(notes[0]).toContain("verify")
  })

  test("no notes on a normal exit", () => {
    expect(outcomeNotes({ aborted: false, expired: false, timeout: 1000 })).toHaveLength(0)
  })
})
