import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, For, Match, Show, Switch, createSignal } from "solid-js"

const id = "internal:sidebar-mcp"

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const on = createMemo(() => list().filter((item) => item.status === "connected").length)
  const bad = createMemo(
    () =>
      list().filter(
        (item) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const dot = (status: string) => {
    if (status === "connected") return theme().success
    if (status === "failed") return theme().error
    if (status === "disabled") return theme().textMuted
    if (status === "needs_auth") return theme().warning
    if (status === "needs_client_registration") return theme().error
    if (status === "pending") return theme().info
    return theme().textMuted
  }

  return (
    <Show when={list().length > 0}>
      {/* 260615 Red section with border title */}
      <box
        border={["top"]}
        borderColor={theme().borderSubtle ?? theme().textMuted}
        title={` MCP ${on()}/${list().length}${bad() > 0 ? ` \u26a0${bad()}` : ""} `}
        titleAlignment="left"
        paddingTop={0}
      >
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().textMuted}>{open() ? "▾" : "▸"}</text>
          </Show>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => {
              // 260615 Red MCP error items: ⚠ prefix + name in error color for visibility
              const isBad = () => item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration"
              return (
                <box flexDirection="row" gap={1}>
                  <text
                    flexShrink={0}
                    style={{
                      fg: dot(item.status),
                    }}
                  >
                    {isBad() ? "⚠" : "•"}
                  </text>
                  <text fg={isBad() ? theme().error : theme().text} wrapMode="word">
                    {item.name}{" "}
                    <span style={{ fg: isBad() ? theme().error : theme().textMuted }}>
                      <Switch fallback={item.status}>
                        <Match when={item.status === "connected"}>Connected</Match>
                        <Match when={(item.status as string) === "pending"}>Waiting…</Match>
                        <Match when={item.status === "failed"}>
                          <i>{item.error}</i>
                        </Match>
                        <Match when={item.status === "disabled"}>Disabled</Match>
                        <Match when={item.status === "needs_auth"}>Needs auth</Match>
                        <Match when={item.status === "needs_client_registration"}>Needs client ID</Match>
                      </Switch>
                    </span>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
