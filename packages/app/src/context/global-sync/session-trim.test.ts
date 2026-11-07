import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@redcode-ai/sdk/v2/client"
import { trimSessions } from "./session-trim"

const session = (input: { id: string; parentID?: string; created: number; updated?: number; archived?: number }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    time: {
      created: input.created,
      updated: input.updated,
      archived: input.archived,
    },
  }) as Session

describe("trimSessions", () => {
  test("keeps base roots and recent roots beyond the limit", () => {
    const now = 1_000_000
    const list = [
      session({ id: "a", created: now - 100_000 }),
      session({ id: "b", created: now - 90_000 }),
      session({ id: "c", created: now - 80_000 }),
      session({ id: "d", created: now - 70_000, updated: now - 1_000 }),
      session({ id: "e", created: now - 60_000, archived: now - 10 }),
    ]

    const result = trimSessions(list, { limit: 2, permission: {}, now })
    expect(result.map((x) => x.id)).toEqual(["a", "b", "c", "d"])
  })

  test("keeps children when root is kept, permission exists, or child is recent", () => {
    const now = 1_000_000
    const list = [
      session({ id: "root-1", created: now - 1000 }),
      session({ id: "root-2", created: now - 2000 }),
      session({ id: "z-root", created: now - 30_000_000 }),
      session({ id: "child-kept-by-root", parentID: "root-1", created: now - 20_000_000 }),
      session({ id: "child-kept-by-permission", parentID: "z-root", created: now - 20_000_000 }),
      session({ id: "child-kept-by-recency", parentID: "z-root", created: now - 500 }),
      session({ id: "child-trimmed", parentID: "z-root", created: now - 20_000_000 }),
    ]

    const result = trimSessions(list, {
      limit: 2,
      permission: {
        "child-kept-by-permission": [{ id: "perm-1" } as PermissionRequest],
      },
      now,
    })

    expect(result.map((x) => x.id)).toEqual([
      "child-kept-by-permission",
      "child-kept-by-recency",
      "child-kept-by-root",
      "root-1",
      "root-2",
    ])
  })

  // 261107 Red 前台会话补回列表：只保缓存不够——getSession 只查 store.session，
  // 被裁出列表后页面取不到会话（child() 判假、子会话变可输入且失去返回入口）。
  test("rescues protected sessions the limit would trim", () => {
    const now = 1_000_000
    const list = [
      session({ id: "a", created: now - 1_000 }),
      session({ id: "b", created: now - 30_000_000 }),
      session({ id: "viewed", created: now - 30_000_000 }),
      session({ id: "child-viewed", parentID: "z-root", created: now - 30_000_000 }),
    ]

    const result = trimSessions(list, {
      limit: 1,
      permission: {},
      now,
      protect: (id) => id === "viewed" || id === "child-viewed",
    })

    expect(result.map((x) => x.id)).toEqual(["a", "child-viewed", "viewed"])
  })
})

// 261107 Red RC-02 边界：前台子会话被救援时，其父链必须一起保——否则 child() 查不到
// 父级判假，子会话失去返回父会话入口（父子导航丢失）。审计建议的边界用例。
test("rescuing a foreground child keeps its parent chain", () => {
  const now = 1_000_000
  const list = [
    session({ id: "fresh-root", created: now - 500 }),
    session({ id: "old-root", created: now - 30_000_000 }),
    session({ id: "old-child", parentID: "old-root", created: now - 29_000_000 }),
  ]

  const result = trimSessions(list, {
    limit: 1,
    permission: {},
    now,
    protect: (id) => id === "old-child",
  })

  expect(result.map((x) => x.id).sort()).toEqual(["fresh-root", "old-child", "old-root"])
})
