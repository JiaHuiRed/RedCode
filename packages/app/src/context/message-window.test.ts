import { describe, expect, test } from "bun:test"
import {
  HELD_MESSAGES_PER_SESSION,
  capMessageWindow,
  holdMessageWindow,
  messageWindowLimit,
} from "./message-window"

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

describe("capMessageWindow", () => {
  const msg = (id: string) => ({ id })

  test("keeps the newest messages and reports the trimmed oldest ones", () => {
    const input = [1, 2, 3, 4, 5].map((n) => msg(`m${n}`))
    const result = capMessageWindow(input, 3)
    expect(result.messages.map((message) => message.id)).toEqual(["m3", "m4", "m5"])
    expect(result.removed.map((message) => message.id)).toEqual(["m1", "m2"])
  })

  test("returns the input unchanged when within the cap", () => {
    const input = [msg("m1"), msg("m2")]
    const result = capMessageWindow(input, HELD_MESSAGES_PER_SESSION)
    expect(result.messages.map((message) => message.id)).toEqual(["m1", "m2"])
    expect(result.removed).toEqual([])
  })

  test("handles an empty window", () => {
    const result = capMessageWindow([], 10)
    expect(result.messages).toEqual([])
    expect(result.removed).toEqual([])
  })
})
