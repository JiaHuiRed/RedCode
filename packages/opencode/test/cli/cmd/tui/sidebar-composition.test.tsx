/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { RGBA } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { ContextSnapshot } from "@redcode-ai/sdk/v2"
import { createSignal, onCleanup, type JSX } from "solid-js"
import { ContextComposition } from "../../../../src/cli/cmd/tui/feature-plugins/sidebar/context-composition"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../../src/cli/cmd/tui/keymap"
import { TuiConfigProvider } from "../../../../src/cli/cmd/tui/context/tui-config"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"

// 261104 Red 组件现在走 useBindings 注册键盘入口，渲染必须带 keymap 与 tuiConfig 上下文；
// onKeymap 把实例交出去，键盘用例可直接 dispatchCommand（无需模拟真实按键）。
function Harness(props: {
  children: (api: TuiPluginApi) => JSX.Element
  onKeymap?: (keymap: ReturnType<typeof createDefaultOpenTuiKeymap>) => void
}) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const tuiConfig = createTuiResolvedConfig()
  // 真实 app 由 registerOpencodeKeymap 注册 leader 等前缀令牌；测试沿用同一入口，
  // 否则 `<leader>i` 会被判为 unknown token 而不进绑定表。
  onCleanup(registerOpencodeKeymap(keymap, renderer, tuiConfig))
  const api = {
    theme: { current: { textMuted: RGBA.fromHex("#888888") } },
    keymap,
    tuiConfig,
  } as unknown as TuiPluginApi
  props.onKeymap?.(keymap)
  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <TuiConfigProvider config={tuiConfig}>{props.children(api)}</TuiConfigProvider>
    </OpencodeKeymapProvider>
  )
}

test("composition loads on demand, expands details, and reuses the same snapshot", async () => {
  let calls = 0
  const [session, setSession] = createSignal("first")
  const app = await testRender(() => (
    <Harness>
      {(api) => <ContextComposition
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
      />}
    </Harness>
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
  const [session, setSession] = createSignal("first")
  let calls = 0
  const pending = new Map<string, (result: { response: Response; data: ContextSnapshot }) => void>()
  const app = await testRender(() => (
    <Harness>
      {(api) => <ContextComposition api={api} sessionID={session()} messages={[]} compact={String}
        load={(id) => {
          calls++
          return new Promise((resolve) => pending.set(id, resolve))
        }} />}
    </Harness>
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
  let calls = 0
  const app = await testRender(() => (
    <Harness>
      {(api) => <ContextComposition api={api} sessionID="test" messages={[]} compact={String}
        load={async () => {
          calls++
          if (calls === 1) return { response: new Response(null, { status: 404 }) }
          throw new Error("network")
        }} />}
    </Harness>
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

// 261104 Red 侧栏 42 列下，后端上限 48 字符的 label（CJK 双宽 96 列）必须裁到单行：
// 不裁时明细行会折成 2–3 行，展开面板被撑高。ascii 与 CJK 各验一次。
test("long labels stay on one line at sidebar width", async () => {
  const app = await testRender(() => (
    <Harness>
      {(api) => <ContextComposition api={api} sessionID="test" messages={[]} compact={String}
        load={async () => ({
          response: new Response(),
          data: {
            providerID: "test", modelID: "test", time: 1_700_000_000_000, total: 100,
            system: {
              tokens: 20, confidence: "medium",
              segments: [{ label: "x".repeat(48), tokens: 10 }, { label: "判".repeat(48), tokens: 10 }],
            },
            tools: { count: 0, tokens: 0, confidence: "low", top: [] },
            messages: { count: 0, tokens: 0, confidence: "medium", byRole: [] },
          },
        })} />}
    </Harness>
  ), { width: 42, height: 20 })
  try {
    await app.renderOnce()
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    await app.renderOnce()
    await app.mockMouse.click(3, 1)
    await app.renderOnce()
    const lines = app.captureCharFrame().split("\n")
    const ascii = lines.filter((line) => line.includes("x"))
    const cjk = lines.filter((line) => line.includes("判"))
    expect(ascii.length).toBe(1)
    expect(cjk.length).toBe(1)
    expect(ascii[0]).toContain("…")
    expect(cjk[0]).toContain("…")
    expect(Bun.stringWidth(ascii[0].trimEnd())).toBeLessThanOrEqual(42)
    expect(Bun.stringWidth(cjk[0].trimEnd())).toBeLessThanOrEqual(42)
  } finally {
    app.renderer.destroy()
  }
})

// 261104 Red 键盘等价操作：命令展开时一次显示三组明细，再触发一次整块收起。
test("keyboard command toggles composition and reveals all groups", async () => {
  let keymap: ReturnType<typeof createDefaultOpenTuiKeymap> | undefined
  const app = await testRender(() => (
    <Harness onKeymap={(value) => { keymap = value }}>
      {(api) => <ContextComposition api={api} sessionID="test" messages={[]} compact={String}
        load={async () => ({
          response: new Response(),
          data: {
            providerID: "test", modelID: "test", time: 1_700_000_000_000, total: 100,
            system: { tokens: 10, confidence: "medium", segments: [{ label: "rules", tokens: 10 }] },
            tools: { count: 1, tokens: 20, confidence: "low", top: [{ label: "read", tokens: 20 }] },
            messages: { count: 1, tokens: 70, confidence: "medium", byRole: [{ label: "user", tokens: 70 }] },
          },
        })} />}
    </Harness>
  ), { width: 42, height: 20 })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("rules 10")
    keymap!.dispatchCommand("sidebar.composition.toggle")
    await app.renderOnce()
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("rules 10")
    expect(frame).toContain("read 20")
    expect(frame).toContain("user 70")
    keymap!.dispatchCommand("sidebar.composition.toggle")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("rules 10")
  } finally {
    app.renderer.destroy()
  }
})
