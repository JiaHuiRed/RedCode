import { describe, expect, test } from "bun:test"
import { notifyDesktop } from "./notifications"

const makeNotificationHarness = ({
  focused = false,
  hasFocus = false,
  focusError = false,
  constructorError = false,
}: {
  focused?: boolean
  hasFocus?: boolean
  focusError?: boolean
  constructorError?: boolean
} = {}) => {
  const calls: string[] = []
  let notification: FakeNotification | undefined
  let resolveClosed: (() => void) | undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  let resolveWarned: (() => void) | undefined
  const warned = new Promise<void>((resolve) => {
    resolveWarned = resolve
  })

  class FakeNotification {
    onclick: Notification["onclick"] = null
    closed = false

    constructor(
      readonly title: string,
      readonly options: NotificationOptions,
    ) {
      if (constructorError) throw new Error("notification constructor failed")
      notification = this
      calls.push("create")
    }

    close() {
      this.closed = true
      calls.push("close")
      resolveClosed?.()
    }
  }

  const api = {
    getWindowFocused: async () => {
      if (focusError) throw new Error("focus lookup failed")
      return focused
    },
    flashFrame: (flash?: boolean) => {
      calls.push(`flash:${flash}`)
    },
    showWindow: async () => {
      calls.push("show")
    },
    setWindowFocus: async () => {
      calls.push("focus")
    },
  }

  return {
    calls,
    closed,
    warned,
    get notification() {
      return notification
    },
    dependencies: {
      title: "Session complete",
      description: "A response is ready",
      href: "/session/exact-session",
      api,
      document: {
        baseURI: "https://desktop.example/renderer/index.html",
        hasFocus: () => hasFocus,
      },
      Notification: FakeNotification,
      handleNotificationClick: (href?: string) => {
        if (href !== undefined) calls.push(`route:${href}`)
      },
      warn: (message: string, error: unknown) => {
        calls.push(`warn:${message}:${String(error)}`)
        resolveWarned?.()
      },
    },
  }
}

describe("notifyDesktop", () => {
  test("skips native notification when the window is focused", async () => {
    const harness = makeNotificationHarness({ focused: true })

    expect(await notifyDesktop(harness.dependencies)).toBe(false)
    expect(harness.notification).toBeUndefined()
    expect(harness.calls).toEqual([])
  })

  test("falls back to document focus when the desktop focus lookup rejects", async () => {
    const harness = makeNotificationHarness({ focusError: true, hasFocus: true })

    expect(await notifyDesktop(harness.dependencies)).toBe(false)
    expect(harness.notification).toBeUndefined()
    expect(harness.calls).toEqual([])
  })

  test("creates a notification when the focus fallback says the window is unfocused", async () => {
    const harness = makeNotificationHarness({ focusError: true, hasFocus: false })

    expect(await notifyDesktop(harness.dependencies)).toBe(true)
    expect(harness.calls).toEqual(["flash:true", "create"])
  })

  test("creates a native notification in the background and flashes the taskbar", async () => {
    const harness = makeNotificationHarness()

    expect(await notifyDesktop(harness.dependencies)).toBe(true)
    expect(harness.calls).toEqual(["flash:true", "create"])
    expect(harness.notification?.title).toBe("Session complete")
    expect(harness.notification?.options).toEqual({
      body: "A response is ready",
      icon: "https://desktop.example/renderer/favicon-96x96-v3.png",
    })
  })

  test("routes the exact href after restoring and focusing, then closes", async () => {
    const harness = makeNotificationHarness()
    await notifyDesktop(harness.dependencies)

    harness.notification?.onclick?.call(harness.notification as Notification, new Event("click"))
    await harness.closed

    expect(harness.calls).toEqual(["flash:true", "create", "show", "focus", "route:/session/exact-session", "close"])
    expect(harness.notification?.closed).toBe(true)
  })

  test("routes and closes even when restore and focus IPC calls reject", async () => {
    const harness = makeNotificationHarness()
    harness.dependencies.api.showWindow = async () => {
      harness.calls.push("show")
      throw new Error("restore failed")
    }
    harness.dependencies.api.setWindowFocus = async () => {
      harness.calls.push("focus")
      throw new Error("focus failed")
    }
    await notifyDesktop(harness.dependencies)

    harness.notification?.onclick?.call(harness.notification as Notification, new Event("click"))
    await harness.closed

    expect(harness.calls).toEqual(["flash:true", "create", "show", "focus", "route:/session/exact-session", "close"])
  })

  test("restores and focuses when href is absent without inventing navigation", async () => {
    const harness = makeNotificationHarness()
    const { href: _href, ...dependencies } = harness.dependencies
    await notifyDesktop(dependencies)

    harness.notification?.onclick?.call(harness.notification as Notification, new Event("click"))
    await harness.closed

    expect(harness.calls).toEqual(["flash:true", "create", "show", "focus", "close"])
    expect(harness.notification?.closed).toBe(true)
  })

  test("closes and warns when routing rejects without an unhandled rejection", async () => {
    const harness = makeNotificationHarness()
    harness.dependencies.handleNotificationClick = async () => {
      throw new Error("route failed")
    }
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on("unhandledRejection", onUnhandled)

    try {
      await notifyDesktop(harness.dependencies)
      harness.notification?.onclick?.call(harness.notification as Notification, new Event("click"))
      await harness.closed
      await harness.warned
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(harness.calls).toEqual([
        "flash:true",
        "create",
        "show",
        "focus",
        "close",
        "warn:Failed to handle desktop notification click:Error: route failed",
      ])
      expect(harness.notification?.closed).toBe(true)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("warns and returns false when native notification construction fails", async () => {
    const harness = makeNotificationHarness({ constructorError: true })

    expect(await notifyDesktop(harness.dependencies)).toBe(false)
    expect(harness.calls).toEqual([
      "flash:true",
      "warn:Failed to create desktop notification:Error: notification constructor failed",
    ])
    expect(harness.notification).toBeUndefined()
  })
})
