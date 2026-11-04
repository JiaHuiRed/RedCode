/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { ContextSnapshot } from "@redcode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { ContextComposition } from "../../../../src/cli/cmd/tui/feature-plugins/sidebar/context-composition"

test("composition loads on demand, expands details, and reuses the same snapshot", async () => {
  let calls = 0
  const api = { theme: { current: { textMuted: RGBA.fromHex("#888888") } } } as unknown as TuiPluginApi
  const [session, setSession] = createSignal("first")
  const app = await testRender(() => (
    <ContextComposition
      api={api}
      sessionID={session()}
      messages={[]}
      compact={String}
      load={async (sessionID) => {
        calls++
        return {
          response: new Response(),
          data: {
            providerID: "test", modelID: sessionID, time: 1_700_000_000_000, total: 100,
            system: { tokens: 10, confidence: "medium", segments: [{ label: "rules", tokens: 10 }] },
            tools: { count: 1, tokens: 20, confidence: "low", top: [{ label: "read", tokens: 20 }] },
            messages: { count: 1, tokens: 70, confidence: "medium", byRole: [{ label: "user", tokens: 70 }] },
          },
        }
      }}
    />
  ), { width: 42, height: 20 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Composition")
    expect(calls).toBe(0)
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    await app.renderOnce()
    expect(calls).toBe(1)
    expect(app.captureCharFrame()).toContain("Messages 70")
    await app.mockMouse.click(3, 1)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("rules 10")
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    expect(calls).toBe(1)
    setSession("second")
    await app.renderOnce()
    await app.renderOnce()
    expect(calls).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("late responses cannot display a previous session's snapshot", async () => {
  const api = { theme: { current: { textMuted: RGBA.fromHex("#888888") } } } as unknown as TuiPluginApi
  const [session, setSession] = createSignal("first")
  let calls = 0
  const pending = new Map<string, (result: { response: Response; data: ContextSnapshot }) => void>()
  const app = await testRender(() => (
    <ContextComposition api={api} sessionID={session()} messages={[]} compact={String}
      load={(id) => {
        calls++
        return new Promise((resolve) => pending.set(id, resolve))
      }} />
  ), { width: 42, height: 20 })
  const result = (tokens: number) => ({
    response: new Response(),
    data: {
      providerID: "test", modelID: "test", time: 1_700_000_000_000, total: tokens,
      system: { tokens, confidence: "medium" as const, segments: [] },
      tools: { count: 0, tokens: 0, confidence: "low" as const, top: [] },
      messages: { count: 0, tokens: 0, confidence: "medium" as const, byRole: [] },
    },
  })
  try {
    await app.renderOnce()
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    expect(pending.size).toBe(1)
    expect(calls).toBe(1)
    setSession("second")
    await app.renderOnce()
    expect(pending.has("first")).toBe(true)
    expect(pending.has("second")).toBe(true)
    pending.get("second")!(result(222))
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("System 222")
    pending.get("first")!(result(111))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("System 222")
    expect(app.captureCharFrame()).not.toContain("System 111")
  } finally {
    app.renderer.destroy()
  }
})

test("404 and network failures show distinct states and can be retried", async () => {
  const api = { theme: { current: { textMuted: RGBA.fromHex("#888888") } } } as unknown as TuiPluginApi
  let calls = 0
  const app = await testRender(() => (
    <ContextComposition api={api} sessionID="test" messages={[]} compact={String}
      load={async () => {
        calls++
        if (calls === 1) return { response: new Response(null, { status: 404 }) }
        throw new Error("network")
      }} />
  ), { width: 42, height: 10 })
  try {
    await app.renderOnce()
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("暂无构成快照")
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    await app.renderOnce()
    expect(calls).toBe(2)
    expect(app.captureCharFrame()).toContain("读取失败")
  } finally {
    app.renderer.destroy()
  }
})
