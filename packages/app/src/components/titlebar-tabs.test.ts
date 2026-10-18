import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Session } from "@redcode-ai/sdk/v2/client"
import { createTitlebarTabs, type TitlebarTab, type TitlebarTabStore } from "./titlebar-tabs"

const tab: TitlebarTab = { dir: "/project", sessionId: "ses_1", href: "/project/session/ses_1" }

function session(title: string) {
  return { id: tab.sessionId, title } as Session
}

describe("titlebar tabs", () => {
  test("shows a session loaded after its tab was created", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<TitlebarTabStore>({ session: [], session_status: {} })
      const tabs = createTitlebarTabs(
        () => [tab],
        () => store,
      )

      expect(tabs()).toEqual([])
      setStore("session", [session("Loaded")])
      expect(tabs().map((item) => item.info.title)).toEqual(["Loaded"])
      dispose()
    })
  })

  test("tracks title edits and replaced session objects", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<TitlebarTabStore>({
        session: [session("New session")],
        session_status: {},
      })
      const tabs = createTitlebarTabs(
        () => [tab],
        () => store,
      )

      expect(tabs()[0]?.info.title).toBe("New session")
      setStore("session", 0, "title", "Renamed")
      expect(tabs()[0]?.info.title).toBe("Renamed")
      setStore("session", [session("Replaced")])
      expect(tabs()[0]?.info.title).toBe("Replaced")
      dispose()
    })
  })

  test("tracks session status changes", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<TitlebarTabStore>({
        session: [session("Title")],
        session_status: {},
      })
      const tabs = createTitlebarTabs(
        () => [tab],
        () => store,
      )
      expect(tabs()[0]?.status).toBeUndefined()

      setStore("session_status", tab.sessionId, { type: "idle" })
      expect(tabs()[0]?.status).toBe("idle")
      setStore("session_status", tab.sessionId, { type: "busy" })
      expect(tabs()[0]?.status).toBe("busy")
      dispose()
    })
  })
})
