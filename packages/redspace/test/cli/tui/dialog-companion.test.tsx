/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { CompanionInfo } from "@redcode-ai/sdk/v2"
import { DialogCompanion } from "../../../src/cli/cmd/tui/component/dialog-companion"
import {
  CompanionIntroduction,
  DialogCompanionIntroduction,
} from "../../../src/cli/cmd/tui/component/companion-introduction"
import type { PromptRef } from "../../../src/cli/cmd/tui/component/prompt"
import type { PromptInfo } from "../../../src/cli/cmd/tui/component/prompt/history"
import { promptStashContext } from "../../../src/cli/cmd/tui/component/prompt/stash"
import { context as LocalContext } from "../../../src/cli/cmd/tui/context/local"
import { context as KVContext } from "../../../src/cli/cmd/tui/context/kv"
import { RouteProvider, useRoute } from "../../../src/cli/cmd/tui/context/route"
import { PromptRefProvider } from "../../../src/cli/cmd/tui/context/prompt"
import { mountBackgroundDialog } from "../../fixture/background-dialog"

const profile = (id: string, name = id): CompanionInfo => ({
  id,
  name,
  soulID: id,
  directory: "/test",
  createdAt: 1,
  files: 2,
  warnings: [],
  timezone: "UTC",
  introduction: "available",
})

function companions(initial: CompanionInfo[]) {
  const [state, setState] = createStore({ profiles: initial })
  return {
    list: () => state.profiles,
    ready: () => true,
    error: () => "",
    refresh: async () => true,
    get: (id: string) => state.profiles.find((item) => item.id === id),
    remember: (value: CompanionInfo) =>
      setState("profiles", (items) => [...items.filter((item) => item.id !== value.id), value]),
  }
}

async function mountChoices(input: {
  profiles: CompanionInfo[]
  create?: (request: {
    companionCreateInput: { requestID: string }
  }) => Promise<{ data: { profile: CompanionInfo; created: boolean } }>
  storage?: Map<string, unknown>
}) {
  const storage = input.storage ?? new Map<string, unknown>()
  const created: string[] = []
  let route: ReturnType<typeof useRoute> | undefined
  function Content() {
    route = useRoute()
    return <DialogCompanion />
  }
  const modal = await mountBackgroundDialog(
    () => (
      <KVContext.Provider
        value={
          {
            ready: true,
            get: (key: string) => storage.get(key),
            set: (key: string, value: unknown) => storage.set(key, value),
          } as never
        }
      >
        <LocalContext.Provider value={{ companion: companions(input.profiles) } as never}>
          <RouteProvider>
            <Content />
          </RouteProvider>
        </LocalContext.Provider>
      </KVContext.Provider>
    ),
    {
      companion: { create: input.create },
      session: {
        list: async () => ({ data: [] }),
        create: async (request: { mode: string; companionID: string }) => {
          expect(request.mode).toBe("chat")
          created.push(request.companionID)
          return {
            data: { id: `session-${request.companionID}`, companionID: request.companionID, directory: "/test" },
          }
        },
      },
    },
  )
  await modal.until(() => /新建(?:的)?伙伴/.test(modal.app.captureCharFrame()))
  return { ...modal, created, storage, route: () => route?.data }
}

test("empty Chat offers creation and opens the new companion's blank Chat", async () => {
  const requests: string[] = []
  const modal = await mountChoices({
    profiles: [],
    create: async (request) => {
      requests.push(request.companionCreateInput.requestID)
      return { data: { profile: profile("new"), created: true } }
    },
  })
  try {
    expect(await modal.paint()).not.toContain("import")
    modal.app.mockInput.pressEnter()
    await modal.until(() => modal.created.length === 1)
    expect(modal.created).toEqual(["new"])
    expect(requests[0]).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(modal.route()).toMatchObject({ type: "session", sessionID: "session-new" })
    expect([...modal.storage.values()].filter(Boolean)).toEqual([])
  } finally {
    modal.app.renderer.destroy()
  }
})

test("one existing companion keeps its entry and can create the second", async () => {
  const modal = await mountChoices({
    profiles: [profile("first", "Existing partner")],
    create: async () => ({ data: { profile: profile("second"), created: true } }),
  })
  try {
    expect(await modal.paint()).toContain("Existing partner")
    modal.app.mockInput.pressArrow("down")
    modal.app.mockInput.pressEnter()
    await modal.until(() => modal.created.length === 1)
    expect(modal.created).toEqual(["second"])
  } finally {
    modal.app.renderer.destroy()
  }
})

test("at capacity creation is read-only and legacy extra companions remain selectable", async () => {
  for (const count of [2, 3]) {
    let calls = 0
    const modal = await mountChoices({
      profiles: Array.from({ length: count }, (_, i) => profile(`partner-${i}`)),
      create: async () => {
        calls++
        throw new Error("must not create")
      },
    })
    try {
      expect(await modal.paint()).toContain("最多可以有两位伙伴")
      expect(await modal.paint()).toContain(`partner-${count - 1}`)
      for (let i = 1; i < count; i++) modal.app.mockInput.pressArrow("down")
      modal.app.mockInput.pressEnter()
      await modal.until(() => modal.created.length === 1)
      expect(modal.created).toEqual([`partner-${count - 1}`])
      expect(calls).toBe(0)
    } finally {
      modal.app.renderer.destroy()
    }
  }
})

test("creation retries after closing the dialog retain their request identity", async () => {
  const storage = new Map<string, unknown>()
  const requests: string[] = []
  const create = async (request: { companionCreateInput: { requestID: string } }) => {
    requests.push(request.companionCreateInput.requestID)
    throw new Error("response lost")
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const modal = await mountChoices({ profiles: [], storage, create })
    try {
      modal.app.mockInput.pressEnter()
      await modal.until(() => modal.app.captureCharFrame().includes("response lost"))
    } finally {
      modal.app.renderer.destroy()
    }
  }
  expect(requests).toHaveLength(2)
  expect(requests[1]).toBe(requests[0])
})

test("starting an introduction preserves the draft and submits a real user message in normal mode", async () => {
  const original: PromptInfo = {
    input: "my unfinished task",
    parts: [{ type: "file", mime: "text/plain", url: "file:///test/draft.txt", filename: "draft.txt" }],
  }
  let current = original
  const saved: PromptInfo[] = []
  const sent: PromptInfo[] = []
  const updates: unknown[] = []
  const ref: PromptRef = {
    focused: true,
    get current() {
      return current
    },
    set: (value) => {
      current = value
    },
    append: () => {},
    reset: () => {},
    blur: () => {},
    focus: () => {},
    submit: async () => {
      sent.push(current)
      return false
    },
  }
  const modal = await mountBackgroundDialog(
    () => (
      <LocalContext.Provider value={{ companion: companions([profile("new")]) } as never}>
        <promptStashContext.Provider value={{ push: (draft: PromptInfo) => saved.push(draft) } as never}>
          <RouteProvider initialRoute={{ type: "session", sessionID: "new-chat" }}>
            <DialogCompanionIntroduction id="new" prompt={() => ref} />
          </RouteProvider>
        </promptStashContext.Provider>
      </LocalContext.Provider>
    ),
    {
      companion: {
        update: async (request: unknown) => {
          updates.push(request)
          return { data: { profile: { ...profile("new"), introduction: "active" } } }
        },
      },
    },
  )
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("开始认识"))
    modal.app.mockInput.pressEnter()
    await modal.until(() => sent.length === 1)
    expect(updates).toEqual([{ id: "new", companionUpdateInput: { introduction: "active" } }])
    expect(saved).toEqual([original])
    expect(sent).toEqual([{ input: "我们先认识一下吧。", parts: [], mode: "normal" }])
    expect(current).toEqual(sent[0])
  } finally {
    modal.app.renderer.destroy()
  }
})

test("a late introduction update cannot send into a different session's composer", async () => {
  let finish!: (result: unknown) => void
  let requested = false
  const response = new Promise((resolve) => {
    finish = resolve
  })
  const data = companions([profile("new")])
  let route!: ReturnType<typeof useRoute>
  const sends: string[] = []
  const ref = {
    current: { input: "other draft", parts: [] },
    set: () => sends.push("changed"),
    submit: () => sends.push("sent"),
  }
  function Content() {
    route = useRoute()
    return <DialogCompanionIntroduction id="new" prompt={() => ref as unknown as PromptRef} />
  }
  const modal = await mountBackgroundDialog(
    () => (
      <LocalContext.Provider value={{ companion: data } as never}>
        <promptStashContext.Provider value={{ push: () => sends.push("stashed") } as never}>
          <RouteProvider initialRoute={{ type: "session", sessionID: "first" }}>
            <Content />
          </RouteProvider>
        </promptStashContext.Provider>
      </LocalContext.Provider>
    ),
    {
      companion: {
        update: () => {
          requested = true
          return response
        },
      },
    },
  )
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("开始认识"))
    modal.app.mockInput.pressEnter()
    await modal.until(() => requested)
    route.navigate({ type: "session", sessionID: "second" })
    finish({ data: { profile: { ...profile("new"), introduction: "active" } } })
    await modal.until(() => modal.app.captureCharFrame().includes("当前聊天已切换"))
    expect(sends).toEqual([])
  } finally {
    modal.app.renderer.destroy()
  }
})

test("existing companions without setup state have no introduction nudge", async () => {
  const existing = { ...profile("existing"), introduction: undefined }
  const modal = await mountBackgroundDialog(
    () => (
      <LocalContext.Provider value={{ companion: companions([existing]) } as never}>
        <PromptRefProvider>
          <CompanionIntroduction id="existing" />
        </PromptRefProvider>
      </LocalContext.Provider>
    ),
    {},
  )
  try {
    expect(await modal.paint()).not.toContain("开始认识")
    expect(await modal.paint()).not.toContain("认识彼此")
  } finally {
    modal.app.renderer.destroy()
  }
})
