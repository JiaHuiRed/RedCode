import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createOpencodeClient } from "../src/v2/client.js"

afterEach(() => mock.restore())

function transport(handle: (request: Request) => Promise<Response>) {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      handle(input instanceof Request && !init ? input : new Request(input, init)),
    globalThis.fetch,
  )
}

function client(mode: "default" | "custom", fetcher: typeof fetch, signal?: AbortSignal) {
  if (mode === "default") spyOn(globalThis, "fetch").mockImplementation(fetcher)
  return createOpencodeClient({
    baseUrl: "http://localhost",
    fetch: mode === "custom" ? fetcher : undefined,
    signal,
    throwOnError: true,
  })
}

describe.each(["default", "custom"] as const)("%s fetch deadline", (mode) => {
  test("retains the existing deadline and caller cancellation", async () => {
    const deadline = new AbortController()
    const caller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
    const requests: Request[] = []
    const sdk = client(
      mode,
      transport(async (request) => {
        requests.push(request)
        return Response.json([])
      }),
    )

    await sdk.file.list({ path: "" }, { signal: caller.signal })
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(60_000)
    expect(requests[0].signal.aborted).toBe(false)
    caller.abort(new Error("caller stopped"))
    expect(requests[0].signal.reason).toBe(caller.signal.reason)
  })

  test("rejects a stalled request when the deadline fires", async () => {
    const deadline = new AbortController()
    const caller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
    const requests: Request[] = []
    const sdk = client(
      mode,
      transport((request) => {
        requests.push(request)
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
          if (request.signal.aborted) reject(request.signal.reason)
        })
      }),
    )
    const result = sdk.file.list({ path: "" }, { signal: caller.signal }).catch((error: unknown) => error)

    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(requests).toHaveLength(1)
      expect(timeout).toHaveBeenCalledWith(60_000)
      deadline.abort(new DOMException("request deadline", "TimeoutError"))
      expect(requests[0].signal.aborted).toBe(true)
      expect(await result).toBe(deadline.signal.reason)
    } finally {
      caller.abort()
      deadline.abort()
      await result
    }
  })

  test("also aborts a stalled response body", async () => {
    const deadline = new AbortController()
    const caller = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
    const sdk = client(
      mode,
      transport(async (request) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal.addEventListener("abort", () => controller.error(request.signal.reason), { once: true })
          },
        })
        return new Response(body, { headers: { "Content-Type": "application/json" } })
      }),
    )
    const result = sdk.file.list({ path: "" }, { signal: caller.signal }).catch((error: unknown) => error)

    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(timeout).toHaveBeenCalledWith(60_000)
      deadline.abort(new DOMException("body deadline", "TimeoutError"))
      expect(await result).toBe(deadline.signal.reason)
    } finally {
      caller.abort()
      deadline.abort()
      await result
    }
  })

  test("retains configured caller cancellation", async () => {
    spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal)
    const caller = new AbortController()
    const requests: Request[] = []
    const sdk = client(
      mode,
      transport(async (request) => {
        requests.push(request)
        return Response.json([])
      }),
      caller.signal,
    )

    await sdk.file.list({ path: "" })
    caller.abort(new Error("configured caller stopped"))
    expect(requests[0].signal.aborted).toBe(true)
    expect(requests[0].signal.reason).toBe(caller.signal.reason)
  })

  test("uses a timer deadline when native timeout is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
    const original = globalThis.setTimeout
    const deadlines: Array<() => void> = []
    spyOn(globalThis, "setTimeout").mockImplementation((handler, ms, ...args) => {
      if (ms !== 60_000) return original(handler, ms, ...args)
      deadlines.push(() => handler(...args))
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined })
    try {
      const requests: Request[] = []
      const sdk = client(
        mode,
        transport(async (request) => {
          requests.push(request)
          return Response.json([])
        }),
      )

      await sdk.file.list({ path: "" })
      expect(deadlines).toHaveLength(1)
      expect(requests[0].signal.aborted).toBe(false)
      deadlines[0]()
      expect(requests[0].signal.aborted).toBe(true)
      expect(requests[0].signal.reason.name).toBe("TimeoutError")
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, "timeout", descriptor)
      else Reflect.deleteProperty(AbortSignal, "timeout")
    }
  })

  test("does not replace an already-aborted caller signal", async () => {
    spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal)
    const caller = new AbortController()
    caller.abort(new Error("already stopped"))
    const sdk = client(
      mode,
      transport(async (request) => {
        request.signal.throwIfAborted()
        return Response.json([])
      }),
    )

    expect(await sdk.file.list({ path: "" }, { signal: caller.signal }).catch((error: unknown) => error)).toBe(
      caller.signal.reason,
    )
  })

  test("preserves request method, headers, and serialized body", async () => {
    spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal)
    const requests: Request[] = []
    const bodies: string[] = []
    const sdk = client(
      mode,
      transport(async (request) => {
        requests.push(request)
        bodies.push(await request.text())
        return Response.json({})
      }),
    )

    await sdk.global.upgrade({ target: "test-version" }, { headers: { "x-test": "preserved" } })
    expect(requests[0].method).toBe("POST")
    expect(requests[0].headers.get("x-test")).toBe("preserved")
    expect(requests[0].headers.get("Content-Type")).toBe("application/json")
    expect(JSON.parse(bodies[0])).toEqual({ target: "test-version" })
  })

  test.each(["global", "directory"] as const)("%s SSE stays exempt and retains caller abort", async (scope) => {
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal)
    const caller = new AbortController()
    const requests: Request[] = []
    const sdk = client(
      mode,
      transport(async (request) => {
        requests.push(request)
        return new Response('data: {"type":"server.connected"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        })
      }),
    )
    const options = { signal: caller.signal, sseMaxRetryAttempts: 1 }
    const events = scope === "global" ? await sdk.global.event(options) : await sdk.event.subscribe(undefined, options)

    expect((await events.stream.next()).done).toBe(false)
    expect(timeout).not.toHaveBeenCalled()
    expect(new URL(requests[0].url).pathname).toBe(scope === "global" ? "/global/event" : "/event")
    expect(Object.getOwnPropertyDescriptor(requests[0], "timeout")?.value).toBe(false)
    caller.abort()
    expect(requests[0].signal.aborted).toBe(true)
    await events.stream.return()
  })
})
