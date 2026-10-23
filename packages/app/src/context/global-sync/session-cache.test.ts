import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type {
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
  Goal,
} from "@redcode-ai/sdk/v2/client"
import { createSessionCacheLedger, dropSessionCaches } from "./session-cache"
import { pathKey } from "@/utils/path-key"
import { createPrefetch } from "@/pages/layout/prefetch"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  isSessionPrefetchCurrent,
} from "./session-prefetch"

const msg = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const part = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) as Part

describe("app session cache", () => {
  test("keeps the prefetch budget across visibility changes", () => {
    const ledger = createSessionCacheLedger()
    for (let index = 0; index < 10; index++) {
      expect(ledger.prefetch("dir", `ses_${index}`)).toEqual([])
    }
    expect(ledger.prefetch("dir", "ses_10")).toEqual(["ses_0"])
    expect(ledger.prefetch("dir", "ses_0")).toEqual(["ses_1"])
  })

  test("promotes foreground sessions without allowing prefetch to evict them", () => {
    const ledger = createSessionCacheLedger()
    for (let index = 0; index < 10; index++) ledger.prefetch("dir", `ses_${index}`)
    expect(ledger.foreground("dir", "ses_0")).toEqual([])
    expect(ledger.prefetch("dir", "ses_10")).toEqual([])
    for (let index = 11; index < 20; index++) expect(ledger.prefetch("dir", `ses_${index}`)).toHaveLength(1)
    expect(ledger.prefetch("dir", "ses_0")).toEqual([])
    for (let index = 1; index < 40; index++) expect(ledger.foreground("dir", `ses_${index}`)).toEqual([])
    expect(ledger.foreground("dir", "ses_40")).toEqual(["ses_0"])
  })

  test("forgets all directory ownership when the directory is disposed", () => {
    const ledger = createSessionCacheLedger()
    ledger.foreground("dir", "foreground")
    ledger.prefetch("dir", "prefetched")
    ledger.forgetDirectory("dir")
    expect(ledger.prefetch("dir", "foreground")).toEqual([])
    expect(ledger.foreground("dir", "foreground")).toEqual([])
  })

  test("uses the child-store directory key for aliases", () => {
    const ledger = createSessionCacheLedger(pathKey)
    const raw = "C:\\Work\\Project"
    const alias = "C:/Work/Project/"
    expect(ledger.prefetch(raw, "ses_1")).toEqual([])
    expect(ledger.foreground(alias, "ses_1")).toEqual([])
    expect(ledger.hasForeground(raw, "ses_1")).toBe(true)
    expect(ledger.prefetch(alias, "ses_1")).toEqual([])
    for (let index = 2; index <= 40; index++) {
      expect(ledger.foreground(raw, `ses_${index}`)).toEqual([])
    }
    expect(ledger.foreground(alias, "ses_41")).toEqual(["ses_1"])
    expect(ledger.hasForeground(raw, "ses_1")).toBe(false)
    expect(ledger.hasForeground(alias, "ses_41")).toBe(true)
    ledger.forgetDirectory(alias)
    expect(ledger.hasForeground(raw, "ses_41")).toBe(false)
  })

  test("real prefetch keeps only ten cached sessions after directories go invisible", async () => {
    const directory = "C:\\Work\\cache-ledger-prefetch"
    const ledger = createSessionCacheLedger(pathKey)
    const [store, setStore] = createStore({
      message: {} as Record<string, Message[] | undefined>,
      part: {} as Record<string, Part[] | undefined>,
      part_text_accum_delta: {} as Record<string, string | undefined>,
      message_trimmed: {} as Record<string, boolean | undefined>,
      todo: {} as Record<string, Todo[] | undefined>,
      goal: {} as Record<string, Goal | undefined>,
      session_status: {} as Record<string, SessionStatus | undefined>,
      session_diff: {} as Record<string, SnapshotFileDiff[] | undefined>,
      permission: {} as Record<string, PermissionRequest[] | undefined>,
      question: {} as Record<string, QuestionRequest[] | undefined>,
    })
    let requests = 0
    const [visible, setVisible] = createSignal([directory])
    const globalSync = {
      child: () => [store, setStore],
      sessionCache: {
        canPrefetch: ledger.canPrefetch,
        prefetch: ledger.prefetch,
        evict: (_directory: string, stale: string[]) => setStore(produce((draft) => dropSessionCaches(draft, stale))),
      },
    } as unknown as Parameters<typeof createPrefetch>[0]["globalSync"]
    const globalSDK = {
      url: "http://localhost",
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => {
            requests++
            return {
              data: Array.from({ length: 40 }, (_, index) => {
                const messageID = `msg_${sessionID}_${index}`
                return {
                  info: msg(messageID, sessionID),
                  parts: [part(`prt_${messageID}`, sessionID, messageID)],
                }
              }),
              response: { headers: new Headers({ "x-next-cursor": "cursor" }) },
            }
          },
        },
      },
    } as unknown as Parameters<typeof createPrefetch>[0]["globalSDK"]
    let prefetchSession!: (session: Session, priority?: "high" | "low") => void
    const dispose = createRoot((dispose) => {
      prefetchSession = createPrefetch({
        visibleSessionDirs: visible,
        currentDir: () => directory,
        sessionId: () => undefined,
        sessions: () => [],
        globalSync,
        globalSDK,
        route: () => undefined,
      }).prefetchSession
      return dispose
    })

    for (let index = 0; index < 10; index++) {
      prefetchSession({ id: `ses_${index}`, directory } as Session, "high")
    }
    while (requests < 10) await new Promise((resolve) => setTimeout(resolve, 1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    setVisible([])
    setVisible([directory])
    const now = Date.now
    Date.now = () => now() + 16_000
    try {
      for (let index = 10; index < 20; index++) {
        prefetchSession({ id: `ses_${index}`, directory } as Session, "high")
      }
      while (requests < 20) await new Promise((resolve) => setTimeout(resolve, 1))
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      Date.now = now
    }
    dispose()
    expect(requests).toBe(20)
    expect(ledger.canPrefetch(directory, "sentinel")).toBe(false)
    expect(Object.keys(store.message)).toHaveLength(10)
    expect(store.message.ses_0).toBeUndefined()
    expect(Object.values(store.message).reduce((sum, messages) => sum + (messages?.length ?? 0), 0)).toBe(400)
    expect(Object.keys(store.part)).toHaveLength(400)
  })

  test("canonical eviction invalidates an in-flight prefetch before it writes", async () => {
    const rawDirectory = "C:\\Work\\prefetch-revision"
    const aliasDirectory = "C:/Work/prefetch-revision/"
    const directory = pathKey(rawDirectory)
    const sessionID = "ses_inflight"
    const ledger = createSessionCacheLedger(pathKey)
    const [store, setStore] = createStore({
      message: {} as Record<string, Message[] | undefined>,
      part: {} as Record<string, Part[] | undefined>,
      part_text_accum_delta: {} as Record<string, string | undefined>,
      message_trimmed: {} as Record<string, boolean | undefined>,
      todo: {} as Record<string, Todo[] | undefined>,
      goal: {} as Record<string, Goal | undefined>,
      session_status: {} as Record<string, SessionStatus | undefined>,
      session_diff: {} as Record<string, SnapshotFileDiff[] | undefined>,
      permission: {} as Record<string, PermissionRequest[] | undefined>,
      question: {} as Record<string, QuestionRequest[] | undefined>,
    })
    let beginResponse!: () => void
    const started = new Promise<void>((resolve) => {
      beginResponse = resolve
    })
    let resolveResponse!: (value: {
      data: { info: Message; parts: Part[] }[]
      response: { headers: Headers }
    }) => void
    const pendingResponse = new Promise<{
      data: { info: Message; parts: Part[] }[]
      response: { headers: Headers }
    }>((resolve) => {
      resolveResponse = resolve
    })
    const globalSync = {
      child: () => [store, setStore],
      sessionCache: {
        canPrefetch: ledger.canPrefetch,
        prefetch: ledger.prefetch,
        evict: (dir: string, stale: string[]) => {
          clearSessionPrefetch(pathKey(dir), stale)
          setStore(produce((draft) => dropSessionCaches(draft, stale)))
        },
      },
    } as unknown as Parameters<typeof createPrefetch>[0]["globalSync"]
    const globalSDK = {
      url: "http://localhost",
      client: {
        session: {
          messages: async () => {
            beginResponse()
            return pendingResponse
          },
        },
      },
    } as unknown as Parameters<typeof createPrefetch>[0]["globalSDK"]
    let prefetchSession!: (session: Session, priority?: "high" | "low") => void
    const dispose = createRoot((dispose) => {
      prefetchSession = createPrefetch({
        visibleSessionDirs: () => [rawDirectory],
        currentDir: () => rawDirectory,
        sessionId: () => undefined,
        sessions: () => [],
        globalSync,
        globalSDK,
        route: () => undefined,
      }).prefetchSession
      return dispose
    })

    prefetchSession({ id: sessionID, directory: rawDirectory } as Session, "high")
    await started
    globalSync.sessionCache.evict(aliasDirectory, [sessionID])
    resolveResponse({
      data: [{ info: msg("msg_inflight", sessionID), parts: [part("prt_inflight", sessionID, "msg_inflight")] }],
      response: { headers: new Headers({ "x-next-cursor": "next" }) },
    })
    await getSessionPrefetchPromise(directory, sessionID)

    expect(isSessionPrefetchCurrent(directory, sessionID, 0)).toBe(false)
    expect(getSessionPrefetch(directory, sessionID)).toBeUndefined()
    expect(store.message[sessionID]).toBeUndefined()
    expect(Object.keys(store.part)).toHaveLength(0)
    dispose()
  })

  test("dropSessionCaches clears orphaned parts without message rows", () => {
    const store: {
      session_status: Record<string, SessionStatus | undefined>
      session_diff: Record<string, SnapshotFileDiff[] | undefined>
      todo: Record<string, Todo[] | undefined>
      goal: Record<string, Goal | undefined>
      message: Record<string, Message[] | undefined>
      message_trimmed: Record<string, boolean | undefined>
      part: Record<string, Part[] | undefined>
      permission: Record<string, PermissionRequest[] | undefined>
      question: Record<string, QuestionRequest[] | undefined>
      part_text_accum_delta: Record<string, string | undefined>
    } = {
      session_status: { ses_1: { type: "busy" } as SessionStatus },
      session_diff: { ses_1: [] },
      todo: { ses_1: [] as Todo[] },
      goal: { ses_1: { text: "g", status: "active", tokens_used: 0, turn_count: 0 } as Goal },
      message: {},
      message_trimmed: { ses_1: true },
      part: { msg_1: [part("prt_1", "ses_1", "msg_1")] },
      permission: { ses_1: [] as PermissionRequest[] },
      question: { ses_1: [] as QuestionRequest[] },
      part_text_accum_delta: { prt_1: "streamed text" },
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
    expect(store.message_trimmed.ses_1).toBeUndefined()
    expect(store.part.msg_1).toBeUndefined()
    expect(store.part_text_accum_delta.prt_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.session_diff.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
    expect(store.goal.ses_1).toBeUndefined()
  })

  test("dropSessionCaches clears message-backed parts", () => {
    const m = msg("msg_1", "ses_1")
    const store: {
      session_status: Record<string, SessionStatus | undefined>
      session_diff: Record<string, SnapshotFileDiff[] | undefined>
      todo: Record<string, Todo[] | undefined>
      goal: Record<string, Goal | undefined>
      message: Record<string, Message[] | undefined>
      message_trimmed: Record<string, boolean | undefined>
      part: Record<string, Part[] | undefined>
      permission: Record<string, PermissionRequest[] | undefined>
      question: Record<string, QuestionRequest[] | undefined>
      part_text_accum_delta: Record<string, string | undefined>
    } = {
      session_status: {},
      session_diff: {},
      message_trimmed: {},
      todo: {},
      goal: {},
      message: { ses_1: [m] },
      part: { [m.id]: [part("prt_1", "ses_1", m.id)] },
      permission: {},
      question: {},
      part_text_accum_delta: {},
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
    expect(store.part[m.id]).toBeUndefined()
  })

})
