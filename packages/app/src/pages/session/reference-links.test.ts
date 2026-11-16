import { describe, expect, test } from "bun:test"
import { clearRecentReferences, pushRecentReference, RECENT_REFERENCE_LIMIT, recentReferences } from "./reference-links"

const anchor = (messageID: string) =>
  ({ kind: "message" as const, sessionID: "s1", messageID, role: "assistant" as const })

describe("reference-links", () => {
  test("keeps the newest bounded list and dedups the same source", () => {
    clearRecentReferences("s1")
    for (let index = 0; index < 12; index++) {
      pushRecentReference({ sessionID: "s1", anchor: anchor(`m${index}`), preview: `p${index}` })
    }

    const list = recentReferences("s1")
    expect(list).toHaveLength(RECENT_REFERENCE_LIMIT)
    expect(list[0]?.anchor.kind === "message" && list[0]?.anchor.messageID).toBe("m11")

    pushRecentReference({ sessionID: "s1", anchor: anchor("m5"), preview: "again" })
    expect(recentReferences("s1")).toHaveLength(RECENT_REFERENCE_LIMIT)
    expect(recentReferences("s1")[0]?.preview).toBe("again")
  })

  test("retains at most four sessions", () => {
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      clearRecentReferences(id)
      pushRecentReference({ sessionID: id, anchor: anchor("m1"), preview: id })
    }

    expect(recentReferences("s5")).toHaveLength(1)
    expect(recentReferences("s4")).toHaveLength(1)
    expect(recentReferences("s1")).toHaveLength(0)
  })
})
