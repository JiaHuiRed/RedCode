import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import * as solidJsRouter from "@solidjs/router"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const createInputs: Array<{ soul?: string }> = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
    delivery?: "queued" | "steer"
  }
}> = []
const optimisticSeeded: boolean[] = []
const sentPrompts: Array<{ sessionID: string; delivery?: "queue" | "steer" }> = []
const sentPromptFiles: string[] = []
const defaultClients: string[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const syncedDirectories: string[] = []
const resetScopes: Array<{ dir: string; id?: string } | undefined> = []
const setCalls: Array<{ scope?: { dir: string; id?: string } }> = []
const toasts: string[] = []
const contextAdds: Array<{ scope?: { dir: string; id?: string } }> = []
const contextRemoves: Array<{ key: string; scope?: { dir: string; id?: string } }> = []
let contextItems: Array<Record<string, unknown>> = []
let promptFails = false
let worktreeCreates = 0
let worktreeGate: Promise<void> | undefined
let createFails = false
let dirtyValue = false
let lastSoul = "karina"

let params: { id?: string; dir?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    soul: {
      default: async (input: { client: "tui" | "desktop" }) => {
        defaultClients.push(input.client)
        return { data: { id: "yuqi" } }
      },
    },
    session: {
      create: async (input?: { soul?: string }) => {
        createdSessions.push(directory)
        createInputs.push(input?.soul ? { soul: input.soul } : {})
        if (createFails) throw new Error("synthetic create failure")
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (input?: {
        sessionID: string
        delivery?: "queue" | "steer"
        parts?: Array<{ filename?: string }>
      }) => {
        if (promptFails) throw new Error("synthetic send failure")
        if (input) sentPrompts.push(input)
        sentPromptFiles.push(...(input?.parts ?? []).flatMap((part) => (part.filename ? [part.filename] : [])))
        return { data: undefined }
      },
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => {
        worktreeCreates += 1
        if (worktreeGate) await worktreeGate
        return { data: { directory: `${directory}/new` } }
      },
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  // 261013 Red 不再手工枚举导出面（261003 漏 useLocation、261012 复发）；
  // factory 的 original 实参是 undefined，必须静态 import 真模块展开。
  mock.module("@solidjs/router", () => ({
    ...solidJsRouter,
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({ pathname: "/", search: "", hash: "" }),
  }))

  mock.module("@redcode-ai/ui/toast", () => ({
    showToast: (options: { title?: string } = {}) => {
      toasts.push(options.title ?? "")
      return 0
    },
  }))

  mock.module("@redcode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      ready: () => true,
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    DEFAULT_PROMPT: [{ type: "text", content: "", start: 0, end: 0 }],
    usePrompt: () => ({
      current: () => promptValue,
      dirty: () => dirtyValue,
      reset: (scope?: { dir: string; id?: string }) => {
        resetScopes.push(scope)
      },
      set: (_prompt: unknown, _cursor?: number, scope?: { dir: string; id?: string }) => {
        setCalls.push({ scope })
      },
      context: {
        add: (item: Record<string, unknown>, scope?: { dir: string; id?: string }) => {
          contextAdds.push({ scope })
        },
        remove: (key: string, scope?: { dir: string; id?: string }) => {
          contextRemoves.push({ key, scope })
        },
        items: () => contextItems,
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: [] },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => ({
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  createInputs.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  sentPrompts.length = 0
  sentPromptFiles.length = 0
  defaultClients.length = 0
  promoted.length = 0
  params = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  resetScopes.length = 0
  setCalls.length = 0
  toasts.length = 0
  contextAdds.length = 0
  contextRemoves.length = 0
  contextItems = []
  promptFails = false
  worktreeCreates = 0
  worktreeGate = undefined
  createFails = false
  dirtyValue = false
  lastSoul = "karina"
  selected = "/repo/worktree-a"
  variant = undefined
  promptValue.splice(0, promptValue.length, { type: "text", content: "ls", start: 0, end: 2 })
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("pins the saved soul on a new session in the selected directory without changing the preference", async () => {
    promptValue.push({
      type: "image",
      id: "img-1",
      filename: "diagram.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AA==",
    })
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [
        {
          type: "image",
          id: "img-1",
          filename: "diagram.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,AA==",
        },
      ],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "/repo/worktree-b",
      onNewSessionWorktreeReset: () => undefined,
      lastSoul: () => lastSoul,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(createInputs).toEqual([{ soul: "karina" }])
    expect(lastSoul).toBe("karina")
    expect(createdClients).toEqual(["/repo/worktree-b"])
    expect(sentPromptFiles).toEqual(["diagram.png"])
  })

  test("resolves the desktop default explicitly when no preference is saved", async () => {
    lastSoul = ""
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      lastSoul: () => lastSoul,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(createInputs).toEqual([{ soul: "yuqi" }])
    expect(defaultClients).toEqual(["desktop"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("sends busy messages with the selected per-message delivery", async () => {
    params = { id: "session-1" }
    let delivery: "queue" | "steer" = "queue"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
      delivery: () => delivery,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event
    await submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    delivery = "steer"
    await submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts.map((item) => item.delivery)).toEqual(["queue", "steer"])
    expect(optimistic.map((item) => item.message.delivery)).toEqual(["queued", "steer"])
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toEqual([{ id: "session-1", title: "New session 1" }])
    expect(optimisticSeeded).toEqual([true])
  })

  test("clears the route workspace draft before creating a new session", async () => {
    params = { dir: "/repo/main" }
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resetScopes).toEqual([{ dir: "/repo/main" }, { dir: "/repo/main", id: "session-1" }])
  })

  test("clears the route draft, not the target worktree draft, when a worktree is selected", async () => {
    params = { dir: "/repo/main" }
    selected = "/repo/worktree-b"
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resetScopes).toEqual([{ dir: "/repo/main" }, { dir: "/repo/worktree-b", id: "session-1" }])
  })

  test("restores the route draft when session creation fails without newer input", async () => {
    params = { dir: "/repo/main" }
    createFails = true
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(setCalls).toEqual([{ scope: { dir: "/repo/main" } }])
    expect(toasts).toContain("prompt.toast.promptSendFailed.title")
    expect(toasts).not.toContain("prompt.toast.draftRestoreSkipped.title")
  })

  test("keeps newer input instead of restoring the route draft when creation fails", async () => {
    params = { dir: "/repo/main" }
    createFails = true
    dirtyValue = true
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(setCalls).toEqual([])
    expect(toasts).toContain("prompt.toast.draftRestoreSkipped.title")
  })

  // 261018 Red PI-03：guard 原先在 session.create 之前、worktree.create 之后，
  // 两次 Enter 会在 worktree 的 await 处交错，各建一个工作树后只创建一个会话。
  test("creates one worktree when Enter is pressed twice during creation", async () => {
    params = { dir: "/repo/main" }
    selected = "create"
    let release!: () => void
    worktreeGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event
    const first = submit.handleSubmit(event)
    // 让第一次提交真正走到 worktree.create 的 await
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()

    await Promise.all([first, second])

    expect(worktreeCreates).toBe(1)
    expect(createdSessions).toHaveLength(1)
  })

  // 261018 Red PI-02：评论的移除与恢复都必须钉在提交时的会话上。旧实现调无 scope 的
  // prompt.context.add()，失败回调晚到时会把 A 的评论恢复到当前路由的 B。
  test("restores comment context on the submitted session's scope", async () => {
    params = { dir: "/repo/main", id: "session-1" }
    promptFails = true
    contextItems = [{ key: "c1", type: "file", path: "/repo/a.ts", comment: "why", commentID: "x1" }]

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 1,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const scope = { dir: "/repo/main", id: "session-1" }
    expect(contextRemoves).toEqual([{ key: "c1", scope }])
    expect(contextAdds.map((item) => item.scope)).toEqual([scope])
    expect(toasts).toContain("prompt.toast.promptSendFailed.title")
  })
})
