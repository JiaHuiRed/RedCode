import { expect, test } from "bun:test"
import type { BrowserWindow, Session, WebContents } from "electron"
import { allowRendererPermissions } from "./renderer-permissions"

type RequestHandler = (
  webContents: { id: number },
  permission: string,
  callback: (allowed: boolean) => void,
  details: { requestingUrl: string },
) => void
type CheckHandler = (
  webContents: { id: number } | undefined,
  permission: string,
  requestingOrigin: string,
  details: { requestingUrl: string },
) => boolean

function setup() {
  let requestHandler: RequestHandler | undefined
  let checkHandler: CheckHandler | undefined
  let requestRegistrations = 0
  let checkRegistrations = 0
  const windows: BrowserWindow[] = []
  const session = {
    setPermissionRequestHandler(handler: RequestHandler) {
      requestRegistrations += 1
      requestHandler = handler
    },
    setPermissionCheckHandler(handler: CheckHandler) {
      checkRegistrations += 1
      checkHandler = handler
    },
  } as unknown as Session

  return {
    session,
    windows,
    request: (webContents: WebContents, permission: string, url: string) => {
      let allowed = false
      requestHandler?.(webContents, permission, (value) => (allowed = value), { requestingUrl: url })
      return allowed
    },
    check: (webContents: WebContents | undefined, permission: string, origin: string, url: string) =>
      checkHandler?.(webContents, permission, origin, { requestingUrl: url }) ?? false,
    registrations: () => ({ requestRegistrations, checkRegistrations }),
  }
}

function window(id: number, url = "oc://renderer/index.html") {
  let destroyed = false
  const webContents = { id, getURL: () => url }
  const value = {
    webContents,
    isDestroyed: () => destroyed,
  } as unknown as BrowserWindow
  return {
    value,
    webContents: webContents as WebContents,
    destroy: () => (destroyed = true),
  }
}

test("registers shared-session handlers once and permits every live trusted window", () => {
  const state = setup()
  const first = window(1)
  const second = window(2)
  state.windows.push(first.value, second.value)
  allowRendererPermissions(state.session, () => state.windows)
  allowRendererPermissions(state.session, () => state.windows)

  expect(state.registrations()).toEqual({ requestRegistrations: 1, checkRegistrations: 1 })
  expect(state.request(first.webContents, "clipboard-read", "oc://renderer/index.html")).toBe(true)
  expect(state.request(second.webContents, "clipboard-read", "oc://renderer/index.html")).toBe(true)
  expect(state.check(first.webContents, "clipboard-read", "oc://renderer", "oc://renderer/index.html")).toBe(true)
  expect(state.check(second.webContents, "clipboard-read", "oc://renderer", "oc://renderer/index.html")).toBe(true)

  first.destroy()
  expect(state.request(first.webContents, "clipboard-read", "oc://renderer/index.html")).toBe(false)
})

test("rejects unknown windows, untrusted URLs, and unlisted permissions", () => {
  const state = setup()
  const first = window(1)
  const external = window(2, "https://example.com")
  const unowned = window(3)
  state.windows.push(first.value, external.value)
  allowRendererPermissions(state.session, () => state.windows)

  expect(state.request(external.webContents, "clipboard-read", "https://example.com")).toBe(false)
  expect(state.request(unowned.webContents, "clipboard-read", "oc://renderer/index.html")).toBe(false)
  expect(state.request(first.webContents, "clipboard-read", "https://example.com")).toBe(false)
  expect(state.request(first.webContents, "camera", "oc://renderer/index.html")).toBe(false)
  expect(state.check(external.webContents, "clipboard-read", "https://example.com", "https://example.com")).toBe(false)
  expect(state.check(first.webContents, "camera", "oc://renderer", "oc://renderer/index.html")).toBe(false)
  expect(state.check(undefined, "clipboard-read", "https://example.com", "https://example.com")).toBe(false)
})
