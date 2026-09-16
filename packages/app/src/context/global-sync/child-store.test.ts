import { describe, expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { activeMcpDirectory, createChildStoreManager, setActiveMcpDirectory } from "./child-store"

const child = () => createStore({} as State)

describe("createChildStoreManager", () => {
  test("does not evict the active directory during mark", () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      dispose()
      return current
    })
    if (!owner) throw new Error("owner required")

    const manager = createChildStoreManager({
      owner,
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onDispose() {},
      translate: (key) => key,
      queryOptions: {} as any,
      global: { provider: null! },
    })

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })
})

describe("activeMcpDirectory", () => {
  test("clears when the active route leaves its project", () => {
    setActiveMcpDirectory("/project")
    expect(activeMcpDirectory()).toBe("/project")

    setActiveMcpDirectory("")
    expect(activeMcpDirectory()).toBe("")
  })
})
