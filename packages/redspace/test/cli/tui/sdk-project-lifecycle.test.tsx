/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SDKProvider, useSDK, type EventSource } from "../../../src/cli/cmd/tui/context/sdk"

test("project cleanup unsubscribes even when event subscription finishes after unmount", async () => {
  const subscription = Promise.withResolvers<() => void>()
  let removed = 0
  const events: EventSource = { subscribe: () => subscription.promise }
  const app = await testRender(() => (
    <SDKProvider url="http://redcode.internal" directory="/A" events={events} unselected>
      <box />
    </SDKProvider>
  ))
  app.renderer.destroy()
  subscription.resolve(() => removed++)
  await Promise.resolve()
  expect(removed).toBe(1)
})

test("project cleanup releases the subscription without cancelling connection-owned requests", async () => {
  const connection = new AbortController()
  let removed = 0
  let signal: AbortSignal | undefined
  function Capture() {
    signal = useSDK().signal
    return <box />
  }
  const app = await testRender(() => (
    <SDKProvider
      url="http://redcode.internal"
      directory="/A"
      events={{ subscribe: async () => () => removed++ }}
      requestSignal={connection.signal}
      unselected
    >
      <Capture />
    </SDKProvider>
  ))
  await Promise.resolve()
  app.renderer.destroy()
  expect(removed).toBe(1)
  expect(signal?.aborted).toBe(false)
  connection.abort()
  expect(signal?.aborted).toBe(true)
})
