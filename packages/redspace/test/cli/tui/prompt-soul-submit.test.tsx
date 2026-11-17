/** @jsxImportSource @opentui/solid */
import { RGBA, SyntaxStyle } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { Prompt, type PromptRef } from "../../../src/cli/cmd/tui/component/prompt"
import { PromptHistoryProvider } from "../../../src/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider } from "../../../src/cli/cmd/tui/component/prompt/stash"
import { FrecencyProvider } from "../../../src/cli/cmd/tui/component/prompt/frecency"
import { context as LocalContext } from "../../../src/cli/cmd/tui/context/local"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { EditorContextProvider } from "../../../src/cli/cmd/tui/context/editor"
import { RouteProvider } from "../../../src/cli/cmd/tui/context/route"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { context as SyncContext } from "../../../src/cli/cmd/tui/context/sync"
import { context as KVContext } from "../../../src/cli/cmd/tui/context/kv"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { context as ThemeContext } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/cli/cmd/tui/keymap"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const souls = [
  { id: "karina", name: "柳智敏", displayName: "敏敏", description: "冷静、专注的编码搭档" },
  { id: "yuqi", name: "宋雨琦", displayName: "雨琦", description: "直率、活泼的编码搭档" },
]
const background = RGBA.fromHex("#16161e")
const theme = {
  text: RGBA.fromHex("#e6e6e6"),
  textMuted: RGBA.fromHex("#8a8a8a"),
  primary: RGBA.fromHex("#7aa2f7"),
  secondary: RGBA.fromHex("#bb9af7"),
  accent: RGBA.fromHex("#7aa2f7"),
  success: RGBA.fromHex("#9ece6a"),
  warning: RGBA.fromHex("#e0af68"),
  error: RGBA.fromHex("#f7768e"),
  info: RGBA.fromHex("#7dcfff"),
  background,
  backgroundPanel: RGBA.fromHex("#1a1b26"),
  backgroundElement: RGBA.fromHex("#1a1b26"),
  border: RGBA.fromHex("#8a8a8a"),
  _hasSelectedListItemText: true,
  selectedListItemText: background,
}
const syntax = SyntaxStyle.fromTheme([])

async function mountPrompt(companionID?: string) {
  const selected: string[] = []
  const requests: { pathname: string; body: Record<string, unknown> }[] = []
  const saved: { key: string; value: unknown }[] = []
  let ref: PromptRef | undefined
  let dispatchCommand!: (command: string) => void
  const local = {
    agent: {
      list: () => [{ name: "redmind", displayName: "RedMind", mode: "primary" }],
      current: () => ({ name: "redmind", displayName: "RedMind", mode: "primary" }),
      label: () => "RedMind",
      color: () => theme.primary,
    },
    soul: {
      list: () => souls,
      saved: () => undefined,
      default: () => "karina",
      current: () => souls[0],
      refresh: async () => true,
      select: (id: string) => (selected.push(id), true),
      label: (id: string | undefined) => souls.find((item) => item.id === id)?.displayName,
      creationId: () => "karina",
    },
    model: {
      current: () => ({ providerID: "test", modelID: "model" }),
      parsed: () => ({ provider: "Test", model: "Model", reasoning: false }),
      variant: { current: () => undefined, list: () => [] },
    },
    displayName: { user: "User", agent: "RedMind" },
  }
  const sync = {
    path: { directory: process.cwd(), worktree: process.cwd() },
    data: {
      provider: [],
      provider_default: {},
      agent: [{ name: "redmind", displayName: "RedMind", mode: "primary" }],
      command: [],
      session: [],
      session_status: {},
      message: {},
      mcp_resource: {},
      config: { username: "User", experimental: {} },
    },
    session: { get: () => undefined },
  }
  const kv = {
    get: (_key: string, fallback?: unknown) => fallback,
    set: (key: string, value: unknown) => saved.push({ key, value }),
  }
  const config = createTuiResolvedConfig()
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const pathname = new URL(request.url).pathname
      if (request.method === "POST") requests.push({ pathname, body: await request.json() })
      if (pathname === "/session")
        return Response.json({
          id: "ses_companion_prompt",
          soul: companionID ?? "karina",
          mode: companionID ? "chat" : "code",
          companionID,
        })
      return Response.json({})
    },
    { preconnect: () => {} },
  )

  function OpenPrompt() {
    return <Prompt ref={(value) => (ref = value)} />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    dispatchCommand = (command) => keymap.dispatchCommand(command)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <SDKProvider url="http://127.0.0.1" fetch={fetch} events={{ subscribe: async () => () => {} }}>
            <ArgsProvider>
              <RouteProvider initialRoute={{ type: "home", companionID }}>
                <ProjectProvider>
                  <EditorContextProvider>
                    <SyncContext.Provider value={sync as never}>
                      <LocalContext.Provider value={local as never}>
                        <KVContext.Provider value={kv as never}>
                          <ThemeContext.Provider value={{ theme, syntax: () => syntax } as never}>
                            <ExitProvider>
                              <PromptHistoryProvider>
                                <PromptStashProvider>
                                  <ToastProvider>
                                    <DialogProvider>
                                      <FrecencyProvider>
                                        <OpenPrompt />
                                      </FrecencyProvider>
                                    </DialogProvider>
                                  </ToastProvider>
                                </PromptStashProvider>
                              </PromptHistoryProvider>
                            </ExitProvider>
                          </ThemeContext.Provider>
                        </KVContext.Provider>
                      </LocalContext.Provider>
                    </SyncContext.Provider>
                  </EditorContextProvider>
                </ProjectProvider>
              </RouteProvider>
            </ArgsProvider>
          </SDKProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 30, kittyKeyboard: true })
  const paint = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  await paint()
  if (!ref) throw new Error("Prompt ref was not mounted")
  const waitForFrame = async (text: string, visible: boolean) => {
    const deadline = Date.now() + 2000
    let frame = await paint()
    while (frame.includes(text) !== visible) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for "${text}" visibility=${visible}`)
      await Bun.sleep(10)
      frame = await paint()
    }
    return frame
  }
  const waitForSelection = async (id: string) => {
    const deadline = Date.now() + 2000
    while (!selected.includes(id)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Soul ${id}`)
      await Bun.sleep(10)
      await paint()
    }
  }
  return {
    app,
    ref,
    selected,
    requests,
    saved,
    paint,
    waitForFrame,
    waitForSelection,
    dispatchCommand: (command: string) => dispatchCommand(command),
  }
}

test("prompt.submit keeps the Soul selector open and supports selection or cancellation", async () => {
  const prompt = await mountPrompt()
  try {
    prompt.ref.set({ input: "/soul", parts: [] })
    prompt.ref.focus()
    prompt.dispatchCommand("prompt.submit")
    expect(await prompt.waitForFrame("选择灵魂", true)).toContain("直率、活泼")
    prompt.app.mockInput.pressArrow("down")
    await prompt.paint()
    prompt.app.mockInput.pressEnter()
    await prompt.waitForFrame("选择灵魂", false)
    expect(prompt.selected).toContain("yuqi")

    const selectedBeforeCancel = [...prompt.selected]
    prompt.ref.set({ input: "/soul", parts: [] })
    prompt.ref.focus()
    prompt.dispatchCommand("prompt.submit")
    await prompt.waitForFrame("选择灵魂", true)
    prompt.app.mockInput.pressEscape()
    await prompt.waitForFrame("选择灵魂", false)
    expect(prompt.selected).toEqual(selectedBeforeCancel)
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("prompt.submit selects an explicit Soul without opening the selector", async () => {
  const prompt = await mountPrompt()
  try {
    prompt.ref.set({ input: "/soul yuqi", parts: [] })
    prompt.ref.focus()
    prompt.dispatchCommand("prompt.submit")
    await prompt.waitForSelection("yuqi")
    expect(prompt.selected).toContain("yuqi")
    await prompt.waitForFrame("选择灵魂", false)
  } finally {
    prompt.app.renderer.destroy()
  }
})

// 261008 Red /soul 升级为注册 slash 命令后，补全行回车（dispatchCommand）直开弹窗，无需输入文本
test("prompt.soul command opens the selector directly like registered slashes", async () => {
  const prompt = await mountPrompt()
  try {
    prompt.dispatchCommand("prompt.soul")
    expect(await prompt.waitForFrame("选择灵魂", true)).toContain("直率、活泼")
    prompt.app.mockInput.pressEnter()
    await prompt.waitForFrame("选择灵魂", false)
    expect(prompt.selected).toContain("karina")
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("Chat keeps its companion and does not change Code's Soul preference", async () => {
  const prompt = await mountPrompt("mira")
  try {
    prompt.ref.set({ input: "/soul yuqi", parts: [] })
    expect(await prompt.ref.submit()).toBe(true)
    expect(prompt.selected).toEqual([])
    expect(await prompt.paint()).not.toContain("选择灵魂")
    prompt.dispatchCommand("prompt.soul")
    expect(await prompt.paint()).not.toContain("选择灵魂")
    expect(prompt.selected).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("Chat creates an explicitly bound session before sending its first message", async () => {
  const prompt = await mountPrompt("mira")
  try {
    prompt.ref.set({ input: "Hello again", parts: [] })
    expect(await prompt.ref.submit()).toBe(true)
    expect(prompt.requests[0]).toEqual({
      pathname: "/session",
      body: {
        agent: "redmind",
        mode: "chat",
        companionID: "mira",
        model: { providerID: "test", id: "model" },
      },
    })
    expect(prompt.requests[1]?.pathname).toBe("/session/ses_companion_prompt/prompt_async")
    expect(prompt.saved.some((item) => item.key === "tui.lastSoul")).toBe(false)
  } finally {
    prompt.app.renderer.destroy()
  }
})
