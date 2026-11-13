import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { base64Encode } from "@redcode-ai/core/util/encode"

const toasts: Array<{ id: number; options: any }> = []
const dismissed: number[] = []
const disposers = new Set<() => void>()
let nextToastID = 0

mock.module("@redcode-ai/ui/toast", () => ({
  showToast: (options: any) => {
    const id = ++nextToastID
    toasts.push({ id, options })
    return id
  },
  toaster: {
    dismiss: (id: number) => dismissed.push(id),
  },
}))

const { createSDKNotificationToasts } = await import("./notification-toasts")

type AppEvent = {
  name: string
  details: { type: string; properties: Record<string, unknown> }
}

type SetupOptions = {
  notify?: (title: string, description?: string, href?: string) => Promise<boolean | void>
  permissionsEnabled?: boolean
  agentEnabled?: boolean
  currentSession?: string
  directory?: string
  sessions?: Array<{ id: string; title?: string; parentID?: string }>
  autoResponds?: boolean
}

const asked = (sessionID: string, type = "question.asked", name = "/project", id?: string): AppEvent => ({
  name,
  details: { type, properties: { sessionID, ...(id === undefined ? {} : { id }) } },
})

type LoopType = "ngram" | "nudge" | "replan" | "stop"

const loop = (sessionID: string, type: LoopType = "stop", name = "/project"): AppEvent => ({
  name,
  details: { type: "session.loop_detected", properties: { sessionID, type, textLen: 1200 } },
})

const loopError = (sessionID: string, name = "/project"): AppEvent => ({
  name,
  details: {
    type: "session.error",
    properties: {
      sessionID,
      error: { name: "TextLoopStoppedError", data: { message: "模型输出陷入重复循环，已停止本轮生成" } },
    },
  },
})

const errored = (sessionID: string, name = "/project"): AppEvent => ({
  name,
  details: {
    type: "session.error",
    properties: { sessionID, error: { name: "UnknownError", data: { message: "boom" } } },
  },
})

const setup = (options: SetupOptions = {}) => {
  let dispatch: ((event: AppEvent) => unknown) | undefined
  const translations: Array<{ key: string; params?: Record<string, string | number | boolean> }> = []
  const [currentSession, setCurrentSession] = createSignal(options.currentSession ?? "active")
  const [directory, setDirectory] = createSignal(options.directory ?? "/project")
  const navigations: string[] = []
  const notify = options.notify ?? (async () => false)
  let notifyCalls = 0

  // 261013 Red 真 solid-js 驱动：mock solid-js 是进程级行为替换，会泄漏到同进程后加载的
  // 测试文件（CI 全量单测挂的根因），改用 createRoot + signal 由响应式系统原生重放 effect。
  const dispose = createRoot((rootDispose) => {
    createSDKNotificationToasts({
      globalSDK: {
        event: {
          listen: (listener: (event: AppEvent) => unknown) => {
            dispatch = listener
            return () => {
              dispatch = undefined
            }
          },
        },
      },
      language: {
        t: (key: string, params?: Record<string, string | number | boolean>) => {
          translations.push({ key, params })
          return key
        },
        intl: () => "en",
      },
      permission: { autoResponds: () => options.autoResponds ?? false },
      settings: {
        sounds: { permissionsEnabled: () => false, permissions: () => undefined },
        notifications: {
          permissions: () => options.permissionsEnabled ?? true,
          agent: () => options.agentEnabled ?? true,
        },
      },
      platform: {
        notify: (title: string, description?: string, href?: string) => {
          notifyCalls++
          return notify(title, description, href)
        },
      },
      params: {
        get id() {
          return currentSession()
        },
      },
      currentDir: () => directory(),
      globalSync: {
        child: () => [{ session: options.sessions ?? [{ id: "target", title: "Target" }] }],
      },
      navigate: (href: string) => navigations.push(href),
      setBusy: () => {},
    } as never)
    return rootDispose
  })
  disposers.add(dispose)

  return {
    emit: (event: AppEvent) => dispatch?.(event),
    dispose: () => {
      disposers.delete(dispose)
      dispose()
    },
    setCurrentSession,
    setDirectory,
    navigations,
    translations,
    notifyCalls: () => notifyCalls,
  }
}

describe("SDK notification toasts", () => {
  afterEach(() => {
    for (const dispose of disposers) dispose()
    toasts.length = 0
    dismissed.length = 0
    nextToastID = 0
  })

  test("uses only the system notification when it was created", async () => {
    const app = setup({ notify: async () => true })
    await app.emit(asked("target"))
    expect(toasts).toHaveLength(0)
    expect(app.notifyCalls()).toBe(1)
  })

  test("falls back to an app toast when the platform is focused", async () => {
    const app = setup({ notify: async () => false })
    await app.emit(asked("target"))
    expect(toasts).toHaveLength(1)
  })

  test("falls back to an app toast when notifications are disabled", async () => {
    const app = setup({ agentEnabled: false })
    await app.emit(asked("target"))
    expect(app.notifyCalls()).toBe(0)
    expect(toasts).toHaveLength(1)
  })

  test("falls back to an app toast when system notification creation fails", async () => {
    const app = setup({
      notify: async () => {
        throw new Error("system notification unavailable")
      },
    })
    await app.emit(asked("target"))
    expect(toasts).toHaveLength(1)
  })

  test("does not show app toasts for the current session or its child", async () => {
    const app = setup({
      currentSession: "active",
      notify: async () => false,
      sessions: [
        { id: "active", title: "Active" },
        { id: "child", title: "Child", parentID: "active" },
      ],
    })
    await app.emit(asked("active"))
    await app.emit(asked("child"))
    expect(toasts).toHaveLength(0)
  })

  test("does not show a stale toast after the question was replied to", async () => {
    let finishNotification!: (value: boolean) => void
    const app = setup({
      notify: () => new Promise<boolean>((resolve) => (finishNotification = resolve)),
    })
    const pending = app.emit(asked("target"))
    await app.emit(asked("target", "question.replied"))
    finishNotification(false)
    await pending
    expect(toasts).toHaveLength(0)
  })

  test("does not show a stale toast after navigating to the target session", async () => {
    let finishNotification!: (value: boolean) => void
    const app = setup({
      notify: () => new Promise<boolean>((resolve) => (finishNotification = resolve)),
    })
    const pending = app.emit(asked("target"))
    app.setCurrentSession("target")
    finishNotification(false)
    await pending
    expect(toasts).toHaveLength(0)
  })

  test("does not show a stale toast when the component unmounts", async () => {
    let finishNotification!: (value: boolean) => void
    const app = setup({
      notify: () => new Promise<boolean>((resolve) => (finishNotification = resolve)),
    })
    const pending = app.emit(asked("target"))
    app.dispose()
    finishNotification(false)
    await pending
    expect(toasts).toHaveLength(0)
  })

  test("suppresses duplicate unanswered requests within the cooldown", async () => {
    const app = setup({ notify: async () => false })
    await app.emit(asked("target", "question.asked", "/project", "request-1"))
    await app.emit(asked("target", "question.asked", "/project", "request-2"))
    expect(app.notifyCalls()).toBe(1)
    expect(toasts).toHaveLength(1)
  })

  test("allows a distinct request immediately after replying to the prior toast", async () => {
    const app = setup({ notify: async () => false })
    await app.emit(asked("target", "permission.asked", "/project", "request-1"))
    const previousToastID = toasts[0].id
    await app.emit(asked("target", "permission.replied"))
    await app.emit(asked("target", "question.asked", "/project", "request-2"))
    expect(dismissed).toEqual([previousToastID])
    expect(app.notifyCalls()).toBe(2)
    expect(toasts).toHaveLength(2)
  })

  test("allows a distinct request after replying to a native-only notification", async () => {
    const app = setup({ notify: async () => true })
    await app.emit(asked("target", "question.asked", "/project", "request-1"))
    await app.emit(asked("target", "question.rejected"))
    await app.emit(asked("target", "permission.asked", "/project", "request-2"))
    expect(app.notifyCalls()).toBe(2)
    expect(toasts).toHaveLength(0)
  })

  test("toast action navigates to the session href", async () => {
    const app = setup({ notify: async () => false })
    await app.emit(asked("target"))
    toasts[0].options.actions[0].onClick()
    expect(app.navigations).toHaveLength(1)
    expect(app.navigations[0]).toContain("/session/target")
  })

  test("does not notify or toast when permission is automatically answered", async () => {
    const app = setup({ autoResponds: true })
    await app.emit(asked("target", "permission.asked"))
    expect(app.notifyCalls()).toBe(0)
    expect(toasts).toHaveLength(0)
  })

  test("loop toast uses the event session and project and navigates to it", async () => {
    const app = setup({ currentSession: "active", sessions: [{ id: "active", title: "Active" }] })
    await app.emit(loop("child", "stop", "/other-project"))
    expect(toasts).toHaveLength(1)
    expect(toasts[0].options.title).toBe("notification.loopDetected.stopped.title")
    const description = app.translations.find((entry) => entry.key === "notification.loopDetected.stopped.description")
    expect(description?.params).toEqual({
      sessionTitle: "child",
      projectName: "/other-project",
      type: "stop",
    })
    toasts[0].options.actions[0].onClick()
    expect(app.navigations).toEqual([`/${base64Encode("/other-project")}/session/child`])
  })

  test("loop toast falls back to the full session id when the session has no title", async () => {
    const app = setup({ sessions: [{ id: "ses_0123456789abcdef", title: "  " }] })
    await app.emit(loop("ses_0123456789abcdef", "nudge"))
    const description = app.translations.find((entry) => entry.key === "notification.loopDetected.description")
    expect(description?.params?.sessionTitle).toBe("ses_0123456789abcdef")
  })

  test("distinguishes subagent sessions and worktrees that share a prefix", async () => {
    const app = setup({
      sessions: [
        { id: "ses_ffe5e2d0aaaa", title: "" },
        { id: "ses_ffe5e2d0bbbb", title: "" },
      ],
    })
    await app.emit(loop("ses_ffe5e2d0aaaa", "stop", "/worktrees/alpha/RedCode"))
    await app.emit(loop("ses_ffe5e2d0bbbb", "stop", "/worktrees/beta/RedCode"))
    const labels = app.translations
      .filter((entry) => entry.key === "notification.loopDetected.stopped.description")
      .map((entry) => entry.params)
    expect(labels).toEqual([
      { sessionTitle: "ses_ffe5e2d0aaaa", projectName: "/worktrees/alpha/RedCode", type: "stop" },
      { sessionTitle: "ses_ffe5e2d0bbbb", projectName: "/worktrees/beta/RedCode", type: "stop" },
    ])
  })

  test("loop toast distinguishes real stops from advisory recoveries", async () => {
    const app = setup()
    await app.emit(loop("target", "ngram"))
    await app.emit(loop("target", "stop"))
    await app.emit(loop("target", "nudge"))
    await app.emit(loop("target", "replan"))
    expect(toasts.map((toast) => toast.options.title)).toEqual([
      "notification.loopDetected.stopped.title",
      "notification.loopDetected.stopped.title",
      "notification.loopDetected.title",
      "notification.loopDetected.title",
    ])
    const types = app.translations.filter((entry) => entry.params?.type).map((entry) => entry.params?.type)
    expect(types).toEqual(["N-gram", "stop", "nudge", "replan"])
  })

  test("loop toast identifies the current session from the event instead of guessing", async () => {
    const app = setup({ currentSession: "active", sessions: [{ id: "active", title: "Active" }] })
    await app.emit(loop("active", "replan"))
    expect(toasts).toHaveLength(1)
    const description = app.translations.find((entry) => entry.key === "notification.loopDetected.description")
    expect(description?.params?.sessionTitle).toBe("Active (active)")
  })

  test("suppresses repeated loop events of the same type for one session", async () => {
    const app = setup()
    await app.emit(loop("target", "ngram"))
    await app.emit(loop("target", "ngram"))
    await app.emit(loop("other", "ngram"))
    expect(toasts).toHaveLength(2)
  })

  test("keeps the loop toast when the loop's own error follows it", async () => {
    const app = setup()
    await app.emit(loop("target", "ngram"))
    const toastID = toasts[0].id
    await app.emit(loopError("target"))
    expect(dismissed).toEqual([])
    expect(toasts).toHaveLength(1)
    expect(toasts[0].id).toBe(toastID)
    expect(toasts[0].options.title).toBe("notification.loopDetected.stopped.title")
  })

  test("replaces an advisory loop toast when a real stop error arrives without a stop event", async () => {
    const app = setup()
    await app.emit(loop("target", "nudge"))
    expect(toasts[0].options.title).toBe("notification.loopDetected.title")
    const nudgeToastID = toasts[0].id
    await app.emit(loopError("target"))
    expect(dismissed).toEqual([nudgeToastID])
    expect(toasts).toHaveLength(2)
    expect(toasts[1].options.title).toBe("notification.loopDetected.stopped.title")
    const description = app.translations.find(
      (entry) => entry.key === "notification.loopDetected.stopped.errorDescription",
    )
    expect(description?.params).toEqual({ sessionTitle: "Target (target)", projectName: "/project" })
    toasts[1].options.actions[0].onClick()
    expect(app.navigations).toEqual([`/${base64Encode("/project")}/session/target`])
  })

  test("shows a locatable loop toast when the loop error arrives before the event", async () => {
    const app = setup()
    await app.emit(loopError("target"))
    expect(toasts).toHaveLength(1)
    expect(toasts[0].options.title).toBe("notification.loopDetected.stopped.title")
    const fallback = app.translations.find(
      (entry) => entry.key === "notification.loopDetected.stopped.errorDescription",
    )
    expect(fallback?.params).toEqual({ sessionTitle: "Target (target)", projectName: "/project" })
    await app.emit(loop("target", "stop"))
    expect(toasts).toHaveLength(2)
    expect(dismissed).toEqual([toasts[0].id])
    const description = app.translations.find((entry) => entry.key === "notification.loopDetected.stopped.description")
    expect(description?.params).toEqual({ sessionTitle: "Target (target)", projectName: "/project", type: "stop" })
  })

  test("ordinary errors do not dismiss or suppress the loop reminder", async () => {
    const app = setup()
    await app.emit(loop("target", "stop"))
    await app.emit(errored("target"))
    expect(dismissed).toEqual([])
    expect(toasts).toHaveLength(1)
    await app.emit(loop("target", "nudge"))
    expect(toasts).toHaveLength(2)
    toasts[1].options.actions[0].onClick()
    expect(app.navigations[0]).toContain("/session/target")
  })

  test("ordinary error before a loop event does not hide the loop toast", async () => {
    const app = setup()
    await app.emit(errored("target"))
    expect(toasts).toHaveLength(0)
    await app.emit(loop("target", "replan"))
    expect(toasts).toHaveLength(1)
    expect(toasts[0].options.title).toBe("notification.loopDetected.title")
  })

  test("dismisses the loop toast after navigating to the session", async () => {
    const app = setup()
    await app.emit(loop("target", "stop"))
    const toastID = toasts[0].id
    app.setCurrentSession("target")
    await Promise.resolve()
    expect(dismissed).toEqual([toastID])
  })
})
