import { describe, expect, test } from "bun:test"
import type { CompanionInfo, Session } from "@redcode-ai/sdk/v2/client"
import {
  createChatHomeSubmit,
  emptyChatSubmission,
  restoreChatSubmissions,
  type ChatSubmission,
} from "./chat-home-submit"
import { assignUnboundDraft, clearAcceptedDraft, selectCompanion, upsertCompanion } from "./companion-workspace"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const companion = (id: string): CompanionInfo => ({
  id,
  name: id,
  soulID: id,
  directory: `/companions/${id}`,
  createdAt: 1,
  files: 2,
  warnings: [],
  timezone: "UTC",
})
const a = companion("qiuqiu")
const b = companion("second")

function harness(initial: CompanionInfo[] = [a, b]) {
  const state = {
    profiles: initial,
    selected: initial[0]?.id,
    epoch: 0,
    drafts: { qiuqiu: "A的草稿", second: "B的草稿", default: "" } as Record<string, string>,
    retries: {} as Record<string, ChatSubmission>,
    fail: new Set<string>(),
    initializeGate: undefined as Promise<void> | undefined,
    promptGate: undefined as Promise<void> | undefined,
    invalidSession: false,
    noModels: false,
    modelID: "model-a",
    files: {} as Record<string, { id: string; filename: string; mime: string; url: string }[]>,
    prepareGate: undefined as Promise<void> | undefined,
    lookupError: false,
  }
  const calls = {
    initialized: 0,
    created: [] as string[],
    activated: [] as string[],
    prompts: [] as { companion: string; sessionID: string; messageID: string; text: string }[],
    accepted: [] as string[],
    payloads: [] as { model?: string; files: string[] }[],
    navigated: [] as string[],
  }
  const promptEntered = deferred()
  const sessions = new Map<string, Session>()
  let nextID = 0
  const profile = () => selectCompanion(state.profiles, undefined, state.selected)
  const create = () => {
    let mounted = true
    return {
      unmount: () => {
        mounted = false
      },
      send: createChatHomeSubmit({
        ready: () => true,
        profile,
        text: () => state.drafts[profile()?.id ?? "default"] ?? "",
        options: (owner, kind) => ({
          model: { providerID: "test", modelID: state.modelID },
          files: kind === "message" ? [...(state.files[owner] ?? [])] : [],
        }),
        currentID: () => profile()?.id,
        epoch: () => state.epoch,
        mounted: () => mounted,
        get: (id) => state.retries[id],
        set: (id, value) => {
          state.retries[id] = { ...emptyChatSubmission(), ...state.retries[id], ...value }
        },
        initialize: async () => {
          calls.initialized++
          if (state.initializeGate) await state.initializeGate
          return { ...a, introduction: "available" }
        },
        prepare: async () => {
          if (state.prepareGate) await state.prepareGate
          if (state.noModels) throw new Error("No model configured")
        },
        activate: async (value) => {
          calls.activated.push(value.id)
          return { ...value, introduction: "active" }
        },
        createSession: async (value) => {
          calls.created.push(value.id)
          const session = {
            id: `session-${calls.created.length}`,
            directory: value.directory,
            companionID: state.invalidSession ? b.id : value.id,
            mode: "chat",
          } as Session
          sessions.set(session.id, session)
          return session
        },
        getSession: async (value) => {
          if (state.lookupError) throw new Error("Connection lost")
          return sessions.get(value.id)
        },
        submit: async (session, messageID, text, options) => {
          calls.payloads.push({ model: options.model?.modelID, files: options.files.map(file => file.id) })
          calls.prompts.push({ companion: session.companionID!, sessionID: session.id, messageID, text })
          promptEntered.resolve()
          if (state.promptGate) await state.promptGate
          if (state.fail.has(session.companionID!)) throw new Error("No model configured")
        },
        receivedProfile: (value) => {
          state.profiles = upsertCompanion(state.profiles, value)
        },
        selectInitialized: (id) => {
          state.selected = id
        },
        assignDraft: (id) => {
          state.drafts = assignUnboundDraft(state.drafts, id)
        },
        clearDraft: (id, text) => {
          state.drafts = clearAcceptedDraft(state.drafts, id, text)
        },
        accepted: (session) => {
          calls.accepted.push(session.id)
        },
        navigate: (session) => {
          calls.navigated.push(session.id)
        },
        introductionText: (value) => (value?.introduction === "active" ? "我们接着认识一下吧。" : "我们先认识一下吧。"),
        nextMessageID: () => `message-${++nextID}`,
        error: (error) => (error instanceof Error ? error.message : String(error)),
        invalidSession: () => "Wrong companion",
      }),
    }
  }
  const choose = (id: string) => {
    state.selected = id
    state.epoch++
  }
  return { state, calls, create, choose, promptEntered, deleteSession: (id: string) => sessions.delete(id) }
}

describe("Chat home asynchronous submission", () => {
  test("a new user without a configured model keeps their draft and can retry after setup", async () => {
    const h = harness([])
    h.state.drafts = { default: "先完成这个任务" }
    h.state.noModels = true
    await h.create().send()
    expect(h.calls.created).toEqual([])
    expect(h.calls.accepted).toEqual([])
    expect(h.calls.navigated).toEqual([])
    expect(h.state.drafts[a.id]).toBe("先完成这个任务")
    expect(h.state.retries[a.id].error).toBe("No model configured")
    h.state.noModels = false
    await h.create().send()
    expect(h.calls.initialized).toBe(1)
    expect(h.calls.prompts[0].text).toBe("先完成这个任务")
  })
  test("first initialization transfers the unbound draft, and only accepted sends navigate", async () => {
    const h = harness([])
    const initialize = deferred()
    const response = deferred()
    h.state.drafts = { default: "先帮我做一件事" }
    h.state.initializeGate = initialize.promise
    h.state.promptGate = response.promise
    const pending = h.create().send()
    expect(h.calls.created).toEqual([])
    expect(h.state.drafts.default).toBe("先帮我做一件事")
    initialize.resolve()
    await h.promptEntered.promise
    expect(h.state.selected).toBe(a.id)
    expect(h.state.drafts[a.id]).toBe("先帮我做一件事")
    expect(h.calls.accepted).toEqual([])
    expect(h.calls.navigated).toEqual([])
    response.resolve()
    await pending
    expect(h.calls.prompts[0].text).toBe("先帮我做一件事")
    expect(h.calls.activated).toEqual([])
    expect(h.state.drafts[a.id]).toBe("")
    expect(h.calls.navigated).toEqual(["session-1"])
  })

  test("a late A success cannot clear B's draft or navigate away from B", async () => {
    const h = harness()
    const response = deferred()
    h.state.promptGate = response.promise
    const pending = h.create().send()
    await h.promptEntered.promise
    h.choose(b.id)
    h.state.drafts[b.id] = "B的新草稿"
    response.resolve()
    await pending
    expect(h.calls.prompts[0].companion).toBe(a.id)
    expect(h.state.drafts[a.id]).toBe("")
    expect(h.state.drafts[b.id]).toBe("B的新草稿")
    expect(h.calls.navigated).toEqual([])
  })

  test("captures the clicked model and files before awaiting session preparation", async () => {
    const h = harness()
    const gate = deferred()
    const file = { id: "one", filename: "a.png", mime: "image/png", url: "data:a" }
    h.state.files[a.id] = [file]
    h.state.prepareGate = gate.promise
    const pending = h.create().send()
    h.choose(b.id)
    h.state.files[b.id] = [{ ...file, id: "two" }]
    h.state.modelID = "model-b"
    gate.resolve()
    await pending
    expect(h.calls.payloads).toEqual([{ model: "model-a", files: ["one"] }])
    expect(h.calls.prompts[0].companion).toBe(a.id)
  })

  test("a retry reuses the exact payload ID, but changing its file allocates a fresh ID", async () => {
    const h = harness()
    const file = { id: "one", filename: "file", mime: "text/plain", url: "data:test" }
    h.state.files[a.id] = [file]
    h.state.fail.add(a.id)
    const page = h.create()
    await page.send()
    h.state.retries = restoreChatSubmissions(h.state.retries)
    await page.send()
    h.state.files[a.id] = [{ ...file, id: "two" }]
    await page.send()
    expect(h.calls.prompts.map(p => p.messageID)).toEqual(["message-1", "message-1", "message-2"])
  })

  test("switching A to B and back does not resurrect an old navigation intent", async () => {
    const h = harness()
    const response = deferred()
    h.state.promptGate = response.promise
    const pending = h.create().send()
    await h.promptEntered.promise
    h.choose(b.id)
    h.choose(a.id)
    h.state.drafts[a.id] = "后来写的内容"
    response.resolve()
    await pending
    expect(h.state.drafts[a.id]).toBe("后来写的内容")
    expect(h.calls.navigated).toEqual([])
  })

  test("leaving Chat while a send runs never navigates the user back", async () => {
    const h = harness()
    const response = deferred()
    h.state.promptGate = response.promise
    const page = h.create()
    const pending = page.send()
    await h.promptEntered.promise
    page.unmount()
    response.resolve()
    await pending
    expect(h.calls.accepted).toEqual(["session-1"])
    expect(h.calls.navigated).toEqual([])
  })

  test("A failure survives visiting B and remounting, reusing the original message and session", async () => {
    const h = harness()
    h.state.fail.add(a.id)
    const first = h.create()
    await first.send()
    const failed = h.calls.prompts[0]
    expect(h.state.drafts[a.id]).toBe("A的草稿")
    first.unmount()
    h.choose(b.id)
    await h.create().send()
    h.state.retries = restoreChatSubmissions(JSON.parse(JSON.stringify(h.state.retries)))
    h.state.fail.clear()
    h.choose(a.id)
    await h.create().send()
    expect(h.calls.created).toEqual([a.id, b.id])
    expect(h.calls.prompts[2]).toEqual(failed)
    expect(h.state.drafts[a.id]).toBe("")
  })

  test("retrying a deleted session sends the retained draft in a new session for the same companion", async () => {
    const h = harness()
    h.state.fail.add(a.id)
    const page = h.create()
    await page.send()
    const failed = h.calls.prompts[0]
    expect(h.state.drafts[a.id]).toBe("A的草稿")
    h.deleteSession(failed.sessionID)
    h.state.fail.clear()

    await page.send()
    expect(h.calls.created).toEqual([a.id, a.id])
    expect(h.calls.prompts[1]).toEqual({
      companion: a.id,
      sessionID: "session-2",
      messageID: "message-2",
      text: failed.text,
    })
    expect(h.calls.navigated).toEqual(["session-2"])
    expect(h.state.drafts[a.id]).toBe("")
    expect(h.state.drafts[b.id]).toBe("B的草稿")
  })

  test("a connection error looking up a prepared session does not create a replacement", async () => {
    const h = harness()
    h.state.fail.add(a.id)
    const page = h.create()
    await page.send()
    const failed = h.calls.prompts[0]
    h.state.lookupError = true
    h.state.fail.clear()

    await page.send()
    expect(h.state.retries[a.id].error).toBe("Connection lost")
    expect(h.state.drafts[a.id]).toBe("A的草稿")
    expect(h.calls.created).toEqual([a.id])
    expect(h.calls.prompts).toEqual([failed])
    expect(h.calls.navigated).toEqual([])

    h.state.lookupError = false
    await page.send()
    expect(h.calls.created).toEqual([a.id])
    expect(h.calls.prompts).toEqual([failed, failed])
    expect(h.calls.navigated).toEqual([failed.sessionID])
  })

  test("an optional introduction is a real message and preserves the typed task through failure and retry", async () => {
    const h = harness([{ ...a, introduction: "available" }])
    h.state.fail.add(a.id)
    await h.create().send("introduction")
    const failed = h.calls.prompts[0]
    expect(failed.text).toBe("我们先认识一下吧。")
    expect(h.calls.accepted).toEqual([])
    expect(h.state.drafts[a.id]).toBe("A的草稿")
    h.state.retries = restoreChatSubmissions(h.state.retries)
    h.state.fail.clear()
    await h.create().send("introduction")
    expect(h.calls.prompts[1]).toEqual(failed)
    expect(h.state.drafts[a.id]).toBe("A的草稿")
    expect(h.calls.created).toEqual([a.id])
  })

  test("retry restoration discards in-flight flags, error payloads and full session metadata", () => {
    const restored = restoreChatSubmissions({
      [a.id]: {
        ...emptyChatSubmission(),
        sending: true,
        error: "old transport error",
        messageID: "message-9",
        submittedText: "hello",
        prepared: { id: "session-9", directory: a.directory, companionID: a.id, soulSnapshot: "do not persist" },
      },
    })
    expect(restored[a.id].sending).toBe(false)
    expect(restored[a.id].error).toBe("")
    expect(restored[a.id].messageID).toBe("message-9")
    expect(restored[a.id].prepared).toEqual({ id: "session-9", directory: a.directory, companionID: a.id })
  })

  test("a mismatched prepared session is never sent to and is cleared for a safe retry", async () => {
    const h = harness()
    h.state.invalidSession = true
    await h.create().send()
    expect(h.calls.prompts).toEqual([])
    expect(h.state.retries[a.id].prepared).toBeUndefined()
    expect(h.state.drafts[a.id]).toBe("A的草稿")
    h.state.invalidSession = false
    await h.create().send()
    expect(h.calls.prompts[0].companion).toBe(a.id)
  })
})
