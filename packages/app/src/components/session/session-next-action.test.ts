import { describe, expect, test } from "bun:test"
import type { Session } from "@redcode-ai/sdk/v2/client"
import { readSessionDraft, sessionNextAction, type SessionNextActionDeps } from "./session-next-action"

const session = (overrides: Partial<Session> = {}) =>
  ({
    id: "ses_1",
    directory: "T:/proj",
    title: "title",
    time: { created: 1, updated: 2 },
    ...overrides,
  }) as Session

function deps(input: {
  store?: {
    session?: Session[]
    question?: Record<string, unknown[] | undefined>
    permission?: Record<string, unknown[] | undefined>
  }
  unseen?: number
  unseenError?: boolean
  autoRespond?: boolean
}): SessionNextActionDeps {
  return {
    sync: { peek: () => [{ session: [] as Session[], question: {}, permission: {}, ...input.store }] },
    notification: {
      session: {
        unseenCount: () => input.unseen ?? 0,
        unseenHasError: () => input.unseenError ?? false,
      },
    },
    permission: { autoResponds: () => input.autoRespond ?? false },
  } as unknown as SessionNextActionDeps
}

describe("sessionNextAction", () => {
  test("等待回答优先于授权与未读", () => {
    const value = sessionNextAction(
      session(),
      deps({
        store: { question: { ses_1: [{}] }, permission: { ses_1: [{}] } },
        unseen: 3,
      }),
    )
    expect(value).toEqual({ kind: "question" })
  })

  test("自动批准的权限请求不算等待授权", () => {
    const waiting = sessionNextAction(session(), deps({ store: { permission: { ses_1: [{ id: "perm_1" }] } } }))
    expect(waiting).toEqual({ kind: "permission" })

    const auto = sessionNextAction(
      session(),
      deps({ store: { permission: { ses_1: [{ id: "perm_1" }] } }, autoRespond: true }),
    )
    expect(auto).toBeUndefined()
  })

  test("出错优先于普通未读", () => {
    expect(sessionNextAction(session(), deps({ unseen: 2, unseenError: true }))).toEqual({ kind: "error" })
  })

  test("未读完成算待查看", () => {
    expect(sessionNextAction(session(), deps({ unseen: 4 }))).toEqual({ kind: "unseen" })
  })

  test("没有可靠状态时不猜", () => {
    expect(sessionNextAction(session(), deps({}))).toBeUndefined()
  })
})

const draftPlatform = (raw: string | null) =>
  ({
    platform: "desktop",
    storage: () => ({ getItem: async () => raw }),
  }) as unknown as Parameters<typeof readSessionDraft>[2]

describe("readSessionDraft", () => {
  test("有文字草稿", async () => {
    const raw = JSON.stringify({ prompt: [{ type: "text", content: "继续这个任务" }], context: { items: [] } })
    expect(await readSessionDraft("T:/proj", "ses_1", draftPlatform(raw))).toBe(true)
  })

  test("空白草稿（默认空 prompt）不算", async () => {
    const raw = JSON.stringify({ prompt: [{ type: "text", content: "" }], context: { items: [] } })
    expect(await readSessionDraft("T:/proj", "ses_1", draftPlatform(raw))).toBe(false)
  })

  test("只有评论上下文也算草稿", async () => {
    const raw = JSON.stringify({
      prompt: [{ type: "text", content: "" }],
      context: { items: [{ type: "file", path: "a.ts", comment: "这里要改" }] },
    })
    expect(await readSessionDraft("T:/proj", "ses_1", draftPlatform(raw))).toBe(true)
  })

  test("没有落盘或内容损坏时按没有草稿处理", async () => {
    expect(await readSessionDraft("T:/proj", "ses_1", draftPlatform(null))).toBe(false)
    expect(await readSessionDraft("T:/proj", "ses_1", draftPlatform("{oops"))).toBe(false)
  })
})
