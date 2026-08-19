import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"

// 260615 Red shortcut hint helper
function Hint(props: { key: string; label: string; theme: any }) {
  return (
    <text fg={props.theme.textMuted}>
      <span style={{ fg: props.theme.text }}>{props.key}</span>
      {props.label}
    </text>
  )
}

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpTotal = createMemo(() => Object.values(sync.data.mcp).length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "failed").length)
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  // 260615 Red compact MCP summary for footer
  const mcpSummary = createMemo(() => {
    if (mcpTotal() === 0) return ""
    return mcpError() > 0 ? `${mcp()}/${mcpTotal()}` : `${mcp()}`
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {`${permissions().length}`}
              </text>
            </Show>
            {/* 260615 Red compact service status + shortcut hints */}
            <Show when={mcpTotal() > 0}>
              <text fg={theme.text}>
                <span style={{ fg: mcpError() > 0 ? theme.error : theme.success }}>⊙</span>
                {` MCP ${mcpSummary()}`}
                <Show when={mcpError() > 0}>
                  <span style={{ fg: theme.error }}>{` ⚠${mcpError()}`}</span>
                </Show>
              </text>
            </Show>
            <Show when={lsp().length > 0}>
              <text fg={theme.text}>
                <span style={{ fg: theme.success }}>•</span> {`${lsp().length} LSP`}
              </text>
            </Show>
            <Hint key="^p" label=" cmd" theme={theme} />
            <Hint key="^x" label=" +" theme={theme} />
          </Match>
        </Switch>
      </box>
    </box>
  )
}
