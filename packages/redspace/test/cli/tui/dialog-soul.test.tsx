/** @jsxImportSource @opentui/solid */
import { InputRenderable, RGBA } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { DialogSoul } from "../../../src/cli/cmd/tui/component/dialog-soul"
import { context as LocalContext } from "../../../src/cli/cmd/tui/context/local"
import { context as ThemeContext } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/cli/cmd/tui/keymap"
import { DialogProvider, useDialog } from "../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// 261008 Red 只替换列表数据与主题，挂载真实弹窗/按键；不启动 LocalProvider 或读写 live 配置。
const souls = [
  { id: "karina", name: "柳智敏", displayName: "敏敏", description: "冷静、专注的编码搭档" },
  { id: "yuqi", name: "宋雨琦", displayName: "雨琦", description: "直率、活泼的编码搭档" },
  { id: "wonyoung", name: "张元英", displayName: "元英", description: "轻盈、从容的编码搭档" },
]
const background = RGBA.fromHex("#16161e")
const theme = {
  text: RGBA.fromHex("#e6e6e6"),
  textMuted: RGBA.fromHex("#8a8a8a"),
  primary: RGBA.fromHex("#7aa2f7"),
  accent: RGBA.fromHex("#7aa2f7"),
  background,
  backgroundPanel: RGBA.fromHex("#1a1b26"),
  border: RGBA.fromHex("#8a8a8a"),
  _hasSelectedListItemText: true,
  selectedListItemText: background,
}

async function mountSoul() {
  const selected: string[] = []
  const confirmed: string[] = []
  let closed = false
  const local = {
    soul: {
      list: () => souls,
      saved: () => undefined,
      default: () => "karina",
      current: () => souls[0],
      select: (id: string) => selected.push(id),
      label: (id: string | undefined) => souls.find((item) => item.id === id)?.displayName,
    },
  }

  function Open() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(
        () => <DialogSoul onSelect={(id) => confirmed.push(id)} />,
        () => {
          closed = true
        },
      ),
    )
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <ThemeContext.Provider value={{ theme } as never}>
            <ToastProvider>
              <LocalContext.Provider value={local as never}>
                <DialogProvider>
                  <Open />
                </DialogProvider>
              </LocalContext.Provider>
            </ToastProvider>
          </ThemeContext.Provider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 24, kittyKeyboard: true })
  const paint = async () => {
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    return app.captureCharFrame()
  }
  await paint()
  expect(app.renderer.currentFocusedRenderable).toBeInstanceOf(InputRenderable)
  return { app, paint, selected, confirmed, closed: () => closed }
}

test("Soul modal renders descriptions and confirms the next item with arrow and return", async () => {
  const modal = await mountSoul()
  try {
    const frame = await modal.paint()
    expect(frame).toContain("选择灵魂")
    expect(frame).toContain("冷静、专注")
    expect(frame).toContain("轻盈、从容")
    modal.app.mockInput.pressArrow("down")
    await modal.paint()
    modal.app.mockInput.pressEnter()
    await modal.paint()
    expect(modal.selected).toEqual(["yuqi"])
    expect(modal.confirmed).toEqual(["yuqi"])
    expect(modal.closed()).toBe(true)
    expect(await modal.paint()).not.toContain("选择灵魂")
  } finally {
    modal.app.renderer.destroy()
  }
})

test("Soul modal searches descriptions and confirms the third Soul", async () => {
  const modal = await mountSoul()
  try {
    await modal.app.mockInput.typeText("轻盈")
    const frame = await modal.paint()
    expect(frame).toContain("元英")
    expect(frame).not.toContain("雨琦")
    modal.app.mockInput.pressEnter()
    await modal.paint()
    expect(modal.selected).toEqual(["wonyoung"])
    expect(modal.confirmed).toEqual(["wonyoung"])
  } finally {
    modal.app.renderer.destroy()
  }
})

test("Soul modal shows no matches and escape cancels without changing the selection", async () => {
  const modal = await mountSoul()
  try {
    await modal.app.mockInput.typeText("absent")
    expect(await modal.paint()).toContain("未找到结果")
    modal.app.mockInput.pressEnter()
    await modal.paint()
    expect(modal.selected).toEqual([])
    modal.app.mockInput.pressEscape()
    await modal.paint()
    expect(modal.closed()).toBe(true)
    expect(modal.confirmed).toEqual([])
    expect(await modal.paint()).not.toContain("选择灵魂")
  } finally {
    modal.app.renderer.destroy()
  }
})
