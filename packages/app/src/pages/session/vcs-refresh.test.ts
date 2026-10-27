import { describe, expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createVcsRefresh } from "./vcs-refresh"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("VCS refresh", () => {
  test("waits for debounce when an in-flight request finishes before it expires", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = ["session-vcs", "project"]
    let calls = 0
    let complete!: () => void
    let aborted = false
    const observer = new QueryObserver(client, {
      queryKey: [...key, "git"],
      queryFn: ({ signal }) => {
        calls++
        if (calls > 1) return Promise.resolve([])
        signal.addEventListener("abort", () => (aborted = true))
        return new Promise<never[]>((resolve) => (complete = () => resolve([])))
      },
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => {})
    let dispose!: () => void
    const refresh = createRoot((cleanup) => {
      dispose = cleanup
      return createVcsRefresh({ client, key: () => key, delay: 100 })
    })
    try {
      refresh()
      refresh()
      complete()
      await wait(30)
      expect(calls).toBe(1)
      expect(aborted).toBe(false)
      await wait(120)
      expect(calls).toBe(2)
      await wait(30)
      expect(calls).toBe(2)
    } finally {
      dispose()
      unsubscribe()
      client.clear()
    }
  })

  test("coalesces notifications during a fetch into one follow-up without cancelling it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = ["session-vcs", "project"]
    let calls = 0
    let complete!: () => void
    let aborted = false
    const observer = new QueryObserver(client, {
      queryKey: [...key, "git"],
      queryFn: ({ signal }) => {
        calls++
        if (calls > 1) return Promise.resolve([])
        signal.addEventListener("abort", () => (aborted = true))
        return new Promise<never[]>((resolve) => {
          complete = () => resolve([])
        })
      },
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => {})
    let dispose!: () => void
    const refresh = createRoot((cleanup) => {
      dispose = cleanup
      return createVcsRefresh({
        client,
        key: () => key,
        delay: 10,
      })
    })
    try {
      refresh()
      refresh()
      await wait(30)
      expect(calls).toBe(1)
      expect(aborted).toBe(false)
      complete()
      await wait(30)
      expect(calls).toBe(2)
      expect(aborted).toBe(false)
      await wait(30)
      expect(calls).toBe(2)
    } finally {
      dispose()
      unsubscribe()
      client.clear()
    }
  })

  test("keeps pending refresh bound to its key and drops it on disposal", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let key = ["session-vcs", "first"]
    let complete!: () => void
    let firstCalls = 0
    let secondCalls = 0
    const first = new QueryObserver(client, {
      queryKey: [...key, "git"],
      queryFn: () => {
        firstCalls++
        if (firstCalls > 1) return Promise.resolve([])
        return new Promise<never[]>((resolve) => (complete = () => resolve([])))
      },
      staleTime: Infinity,
    })
    const second = new QueryObserver(client, {
      queryKey: ["session-vcs", "second", "git"],
      queryFn: () => {
        secondCalls++
        return Promise.resolve([])
      },
      staleTime: Infinity,
    })
    const stopFirst = first.subscribe(() => {})
    const stopSecond = second.subscribe(() => {})
    let dispose!: () => void
    const refresh = createRoot((cleanup) => {
      dispose = cleanup
      return createVcsRefresh({ client, key: () => key, delay: 10 })
    })
    try {
      await wait(10)
      refresh()
      key = ["session-vcs", "second"]
      complete()
      await wait(30)
      expect(firstCalls).toBe(2)
      expect(secondCalls).toBe(1)
      refresh()
      dispose()
      await wait(30)
      expect(secondCalls).toBe(1)
    } finally {
      dispose()
      stopFirst()
      stopSecond()
      client.clear()
    }
  })

  test("does not refresh after disposal while a request is in flight", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let complete!: () => void
    let calls = 0
    const observer = new QueryObserver(client, {
      queryKey: ["session-vcs", "project", "git"],
      queryFn: () => {
        calls++
        return new Promise<never[]>((resolve) => (complete = () => resolve([])))
      },
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => {})
    let dispose!: () => void
    const refresh = createRoot((cleanup) => {
      dispose = cleanup
      return createVcsRefresh({ client, key: () => ["session-vcs", "project"], delay: 10 })
    })
    try {
      refresh()
      dispose()
      complete()
      await wait(30)
      expect(calls).toBe(1)
    } finally {
      dispose()
      unsubscribe()
      client.clear()
    }
  })
})
