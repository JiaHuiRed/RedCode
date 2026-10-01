import { afterEach, describe, expect, mock, test } from "bun:test"

const toasts: Array<{ id: number; options: any }> = []
const dismissed: number[] = []
const disposers = new Set<() => void>()
let activeCleanups: Array<() => void> | undefined
let activeEffects: Array<() => void> | undefined
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
mock.module("solid-js", () => ({
  createEffect: (effect: () => void) => {
    activeEffects?.push(effect)
    effect()
  },
  onCleanup: (cleanup: () => void) => activeCleanups?.push(cleanup),
  onMount: (effect: () => void) => effect(),
}))

const { createSDKNotificationToasts } = await import("./notification-toasts")

type AskedEvent = {
  name: string
  details: { type: string; properties: { sessionID: string; id?: string } }
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

const asked = (sessionID: string, type = "question.asked", name = "/project", id?: string): AskedEvent => ({
  name,
  details: { type, properties: { sessionID, ...(id === undefined ? {} : { id }) } },
})

const setup = (options: SetupOptions = {}) => {
  let dispatch: ((event: AskedEvent) => unknown) | undefined
  let currentSession = options.currentSession ?? "active"
  let directory = options.directory ?? "/project"
  const cleanups: Array<() => void> = []
  const effects: Array<() => void> = []
  const navigations: string[] = []
  const notify = options.notify ?? (async () => false)
  let notifyCalls = 0

  activeCleanups = cleanups
  activeEffects = effects
  createSDKNotificationToasts({
    globalSDK: {
      event: {
        listen: (listener: (event: AskedEvent) => unknown) => {
          dispatch = listener
          return () => {
            dispatch = undefined
          }
        },
      },
    },
    language: { t: (key: string) => key, intl: () => "en" },
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
        return currentSession
      },
    },
    currentDir: () => directory,
    globalSync: {
      child: () => [{ session: options.sessions ?? [{ id: "target", title: "Target" }] }],
    },
    navigate: (href: string) => navigations.push(href),
    setBusy: () => {},
  } as never)
  activeCleanups = undefined
  activeEffects = undefined

  const dispose = () => {
    disposers.delete(dispose)
    for (const cleanup of cleanups) cleanup()
  }
  disposers.add(dispose)

  return {
    emit: (event: AskedEvent) => dispatch?.(event),
    dispose,
    setCurrentSession: (sessionID: string) => {
      currentSession = sessionID
      for (const effect of effects) effect()
    },
    setDirectory: (value: string) => {
      directory = value
      for (const effect of effects) effect()
    },
    navigations,
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
})
