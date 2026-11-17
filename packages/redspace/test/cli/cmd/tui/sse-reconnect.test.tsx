/** @jsxImportSource @opentui/solid */
/**
 * SSE reconnect backoff must reset once a connection proves healthy. The
 * attempt counter only ever incremented on stream end, so any history of
 * disconnects inflated the NEXT reconnect's backoff (4s/8s/30s) even after a
 * long stable period. It now zeroes on the first event of each new
 * connection — HTTP 200 alone does not count, a stream can connect and stay
 * silent. Measured through the real loop with scripted /global/event
 * responses: one failed connection, then a healthy one carrying a single
 * event; the gap before the following connect must be the post-reset 1s,
 * not the accumulated 2s.
 */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { wait } from "./sync-fixture"

const connected = `data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`

function sse(frames: string[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("tui sse reconnect", () => {
  test("backoff resets after a healthy connection", async () => {
    const script = [new Response("nope", { status: 500 }), sse([connected])]
    const requestedAt: number[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/global/event") {
        requestedAt.push(Date.now())
        return script.shift() ?? new Response("nope", { status: 500 })
      }
      return new Response("{}", { headers: { "content-type": "application/json" } })
    }) as typeof globalThis.fetch

    const app = await testRender(() => <SDKProvider url="http://test" fetch={fetch} />)
    try {
      await wait(() => requestedAt.length >= 3, 15000)
      // gap between the healthy connection (2nd) and the next connect (3rd):
      // 1s with the reset, 2s without (attempt had already reached 1)
      expect(requestedAt[2] - requestedAt[1]).toBeLessThan(1500)
    } finally {
      app.renderer.destroy()
    }
  })
})
