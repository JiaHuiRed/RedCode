/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX } from "solid-js"
import { sdkContext } from "../../src/cli/cmd/tui/context/sdk"
import { context as SyncContext } from "../../src/cli/cmd/tui/context/sync"
import { context as ThemeContext } from "../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../src/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/cli/cmd/tui/keymap"
import { DialogProvider, useDialog } from "../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../src/cli/cmd/tui/ui/toast"
import { createTuiResolvedConfig } from "./tui-runtime"

export async function mountBackgroundDialog(
  content: (dialog: ReturnType<typeof useDialog>) => JSX.Element,
  client: unknown,
  sync: unknown = { path: { directory: "/test" }, session: { get: () => undefined } },
) {
  const color = RGBA.fromHex("#eeeeee")
  const theme = {
    text: color,
    textMuted: color,
    primary: color,
    accent: color,
    error: color,
    warning: color,
    success: color,
    border: color,
    borderSubtle: color,
    background: color,
    backgroundPanel: color,
    backgroundElement: color,
    selectedListItemText: color,
  }
  function Open() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => content(dialog)))
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
              <sdkContext.Provider value={{ client, directory: "/test" } as never}>
                <SyncContext.Provider value={sync as never}>
                  <DialogProvider>
                    <Open />
                  </DialogProvider>
                </SyncContext.Provider>
              </sdkContext.Provider>
            </ToastProvider>
          </ThemeContext.Provider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 40, kittyKeyboard: true })
  const paint = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Dialog condition timed out:\n${await paint()}`)
      await Bun.sleep(20)
      await paint()
    }
    return paint()
  }
  await paint()
  return { app, paint, until }
}
