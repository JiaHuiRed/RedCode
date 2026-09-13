import { describe, expect, test } from "bun:test"
import { createReconnectRefresh, fetchMessageGap } from "./reconnect"

type Message = { id: string }
type Page = { session: Message[]; part: { id: string; part: unknown[] }[]; cursor?: string; complete: boolean }

const page = (ids: string[], next?: string): Page => ({
  session: ids.map((id) => ({ id })),
  part: [],
  cursor: next,
  complete: next === undefined,
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe("fetchMessageGap", () => {
  test("returns only the latest page when no anchor is given", async () => {
    const calls: (string | undefined)[] = []
    const result = await fetchMessageGap(async (before) => {
      calls.push(before)
      return page(["m3"], "c2")
    })

    expect(calls).toEqual([undefined])
    expect(result.session.map((message) => message.id)).toEqual(["m3"])
    expect(result.cursor).toBe("c2")
    expect(result.complete).toBeFalse()
  })

  test("pages back until the anchor is found and keeps the last cursor", async () => {
    const calls: (string | undefined)[] = []
    const result = await fetchMessageGap(async (before) => {
      calls.push(before)
      if (before === undefined) return page(["m4"], "c3")
      return page(["m3", "m2"])
    }, "m2")

    expect(calls).toEqual([undefined, "c3"])
    expect(result.session.map((message) => message.id)).toEqual(["m4", "m3", "m2"])
    expect(result.cursor).toBeUndefined()
    expect(result.complete).toBeTrue()
  })

  test("stops when the anchor is on the first page", async () => {
    const calls: (string | undefined)[] = []
    const result = await fetchMessageGap(async (before) => {
      calls.push(before)
      return page(["m4", "m3"], "c3")
    }, "m3")

    expect(calls).toEqual([undefined])
    expect(result.session.map((message) => message.id)).toEqual(["m4", "m3"])
  })

  test("rejects a repeated cursor instead of looping forever", async () => {
    await expect(fetchMessageGap(async () => page(["m4"], "c3"), "m1")).rejects.toThrow("repeated or missing cursor")
  })

  test("rejects a missing cursor when the server has not finished paging", async () => {
    await expect(
      fetchMessageGap(async () => ({ session: [{ id: "m4" }], part: [], cursor: "c3", complete: false }), "m1"),
    ).rejects.toThrow("repeated or missing cursor")
  })

  test("caps recovery at 50 pages", async () => {
    let index = 0
    await expect(
      fetchMessageGap(async () => page(["m4"], `c${index++}`), "m1"),
    ).rejects.toThrow("exceeded 50 pages")
  })
})

describe("createReconnectRefresh", () => {
  test("coalesces bursts and re-runs once when a request arrives mid-flight", async () => {
    let runs = 0
    let release: (() => void) | undefined
    const controller = createReconnectRefresh({
      delay: 0,
      refresh: async () => {
        runs += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
      error: () => {
        throw new Error("unexpected refresh error")
      },
    })

    controller.request()
    await tick()
    expect(runs).toBe(1)

    controller.request()
    controller.request()
    release?.()
    await tick()
    expect(runs).toBe(2)

    controller.dispose()
  })

  test("does not refresh after dispose", async () => {
    let runs = 0
    const controller = createReconnectRefresh({
      delay: 0,
      refresh: async () => {
        runs += 1
      },
      error: () => {},
    })

    controller.dispose()
    controller.request()
    await tick()

    expect(runs).toBe(0)
  })
})
