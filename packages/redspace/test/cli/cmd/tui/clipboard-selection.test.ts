import { describe, expect, test } from "bun:test"
import { Selection } from "../../../../src/cli/cmd/tui/util/selection"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createHarness(text: string) {
  let selection = {
    getSelectedText: () => text,
    selectedRenderables: [],
    anchor: { x: 1, y: 1 },
    focus: { x: 2, y: 1 },
  }
  let cleared = 0
  let settle!: () => void
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const errors: unknown[] = []

  return {
    renderer: {
      getSelection: () => selection,
      clearSelection: () => {
        cleared += 1
      },
      currentFocusedRenderable: null,
    },
    toast: {
      show: () => settle(),
      error: (error: unknown) => {
        errors.push(error)
        settle()
      },
    },
    settled,
    errors,
    cleared: () => cleared,
    select(next: string) {
      selection = {
        getSelectedText: () => next,
        selectedRenderables: [],
        anchor: { x: 1, y: 1 },
        focus: { x: 2, y: 1 },
      }
    },
  }
}

describe("TUI clipboard selection", () => {
  test("clears the selection only after the clipboard write succeeds", async () => {
    const clipboard = deferred<void>()
    const harness = createHarness("selected text")

    expect(Selection.copy(harness.renderer, harness.toast, () => clipboard.promise)).toBe(true)
    expect(harness.cleared()).toBe(0)

    clipboard.resolve()
    await harness.settled

    expect(harness.cleared()).toBe(1)
  })

  test("keeps the selection when the clipboard write fails", async () => {
    const clipboard = deferred<void>()
    const harness = createHarness("selected text")
    const error = new Error("clipboard unavailable")

    expect(Selection.copy(harness.renderer, harness.toast, () => clipboard.promise)).toBe(true)
    clipboard.reject(error)
    await harness.settled

    expect(harness.cleared()).toBe(0)
    expect(harness.errors).toEqual([error])
  })

  test("does not clear a newer selection when an older copy completes", async () => {
    const clipboard = deferred<void>()
    const harness = createHarness("first selection")

    Selection.copy(harness.renderer, harness.toast, () => clipboard.promise)
    harness.select("new selection")
    clipboard.resolve()
    await harness.settled

    expect(harness.cleared()).toBe(0)
  })
})
