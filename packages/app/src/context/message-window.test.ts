import { describe, expect, test } from "bun:test"
import { HELD_MESSAGES_PER_SESSION, holdMessageWindow, messageWindowLimit } from "./message-window"

const BASE = 100

describe("messageWindowLimit", () => {
  test("keeps the base limit when nobody holds the session", () => {
    expect(messageWindowLimit("/dir", "ses_plain", BASE)).toBe(BASE)
  })

  test("raises the limit to a bounded value while the session is held", () => {
    const release = holdMessageWindow("/dir", "ses_held")
    expect(messageWindowLimit("/dir", "ses_held", BASE)).toBe(HELD_MESSAGES_PER_SESSION)
    expect(HELD_MESSAGES_PER_SESSION).toBeGreaterThan(BASE)
    release()
    expect(messageWindowLimit("/dir", "ses_held", BASE)).toBe(BASE)
  })

  test("reference counts overlapping holds", () => {
    const first = holdMessageWindow("/dir", "ses_nested")
    const second = holdMessageWindow("/dir", "ses_nested")

    first()
    expect(messageWindowLimit("/dir", "ses_nested", BASE)).toBe(HELD_MESSAGES_PER_SESSION)

    second()
    expect(messageWindowLimit("/dir", "ses_nested", BASE)).toBe(BASE)
  })

  test("scopes holds per directory and session", () => {
    const release = holdMessageWindow("/dir", "ses_one")

    expect(messageWindowLimit("/dir", "ses_two", BASE)).toBe(BASE)
    expect(messageWindowLimit("/other", "ses_one", BASE)).toBe(BASE)

    release()
  })

  test("never lowers a fallback that is already above the held value", () => {
    const release = holdMessageWindow("/dir", "ses_wide")
    expect(messageWindowLimit("/dir", "ses_wide", HELD_MESSAGES_PER_SESSION + 50)).toBe(HELD_MESSAGES_PER_SESSION + 50)
    release()
  })
})
