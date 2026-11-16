import { describe, expect, test } from "bun:test"
import { runUpdateAndRestart } from "./update"

describe("runUpdateAndRestart", () => {
  test("clears the installing state when restart resolves without exiting", async () => {
    const states: boolean[] = []
    await new Promise<void>((resolve) => {
      runUpdateAndRestart(
        async () => {},
        (installing) => {
          states.push(installing)
          if (states.length === 2) resolve()
        },
      )
    })

    expect(states).toEqual([true, false])
  })

  test("clears the installing state when restart rejects", async () => {
    const states: boolean[] = []
    await new Promise<void>((resolve) => {
      runUpdateAndRestart(
        async () => {
          throw new Error("updater failed")
        },
        (installing) => {
          states.push(installing)
          if (states.length === 2) resolve()
        },
      )
    })

    expect(states).toEqual([true, false])
  })

  test("surfaces a failed install result instead of swallowing it", async () => {
    const states: boolean[] = []
    const errors: string[] = []
    await new Promise<void>((resolve) => {
      runUpdateAndRestart(
        async () => ({ status: "failed", reason: "download", error: "connection reset" }),
        (installing) => {
          states.push(installing)
          if (states.length === 2) resolve()
        },
        (error) => errors.push(error),
      )
    })

    expect(states).toEqual([true, false])
    expect(errors).toEqual(["connection reset"])
  })

  test("surfaces a rejected install through onError", async () => {
    const states: boolean[] = []
    const errors: string[] = []
    await new Promise<void>((resolve) => {
      runUpdateAndRestart(
        async () => {
          throw new Error("ipc failed")
        },
        (installing) => {
          states.push(installing)
          if (states.length === 2) resolve()
        },
        (error) => errors.push(error),
      )
    })

    expect(states).toEqual([true, false])
    expect(errors).toEqual(["ipc failed"])
  })

  test("does not report an error when the install completed", async () => {
    const states: boolean[] = []
    const errors: string[] = []
    await new Promise<void>((resolve) => {
      runUpdateAndRestart(
        async () => ({ status: "downloaded", version: "0.12.0" }),
        (installing) => {
          states.push(installing)
          if (states.length === 2) resolve()
        },
        (error) => errors.push(error),
      )
    })

    expect(states).toEqual([true, false])
    expect(errors).toEqual([])
  })
})
