import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSettingsNavigation, resolveSettingsTab } from "./settings-navigation"

describe("settings navigation hydration", () => {
  test("a deep link wins over a late desktop storage read", () => {
    const fixture = createRoot((dispose) => {
      const [state, setState] = createStore({ saved: "general", ready: false })
      const writes: string[] = []
      const navigation = createSettingsNavigation({
        initial: "chat",
        saved: () => state.saved,
        ready: () => state.ready,
        persist: (value) => writes.push(value),
      })
      return { dispose, setState, navigation, writes }
    })
    try {
      expect(fixture.navigation.value()).toBe("chat")
      expect(fixture.writes).toEqual([])
      fixture.setState({ saved: "providers", ready: true })
      expect(fixture.navigation.value()).toBe("chat")
      expect(fixture.writes.at(-1)).toBe("chat")
      fixture.navigation.select("sound")
      expect(fixture.navigation.value()).toBe("sound")
      expect(fixture.writes.at(-1)).toBe("sound")
    } finally {
      fixture.dispose()
    }
  })

  test("a user selection made before hydration also wins", () => {
    const fixture = createRoot((dispose) => {
      const [state, setState] = createStore({ saved: "chat", ready: false })
      const writes: string[] = []
      const navigation = createSettingsNavigation({
        saved: () => state.saved,
        ready: () => state.ready,
        persist: (value) => writes.push(value),
      })
      return { dispose, setState, navigation, writes }
    })
    try {
      fixture.navigation.select("files")
      fixture.setState({ saved: "models", ready: true })
      expect(fixture.navigation.value()).toBe("files")
      expect(fixture.writes.at(-1)).toBe("files")
    } finally {
      fixture.dispose()
    }
  })

  test("normal opens restore the saved page and retired values fall back to Chat", () => {
    expect(resolveSettingsTab({ saved: "personalization" })).toBe("personalization")
    expect(resolveSettingsTab({ saved: "providers" })).toBe("providers")
    expect(resolveSettingsTab({ saved: "retired-page" })).toBe("chat")
    expect(resolveSettingsTab({})).toBe("chat")
  })
})
