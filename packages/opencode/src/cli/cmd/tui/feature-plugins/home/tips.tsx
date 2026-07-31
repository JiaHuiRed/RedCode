import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, Show } from "solid-js"
import { Tips } from "./tips-view"
import { useBindings } from "../../keymap"
import { usePromptMaxWidth } from "@tui/component/prompt/width"

const id = "internal:home-tips"

function View(props: { api: TuiPluginApi; hidden: boolean; show: boolean; connected: boolean }) {
  // 260731 Red 跟输入框共用宽度上限，此前这里写死 75，配了 tui.prompt.max_width 就对不齐
  const maxWidth = usePromptMaxWidth()
  useBindings(() => ({
    commands: [
      {
        name: "tips.toggle",
        title: props.hidden ? "显示提示" : "隐藏提示",
        category: "System",
        namespace: "palette",
        run() {
          props.api.kv.set("tips_hidden", !props.api.kv.get("tips_hidden", false))
          props.api.ui.dialog.clear()
        },
      },
    ],
    bindings: props.api.tuiConfig.keybinds.get("tips.toggle"),
  }))

  return (
    <box width="100%" maxWidth={maxWidth()} alignItems="center" paddingTop={3} flexShrink={1}>
      <Show when={props.show}>
        <Tips api={props.api} connected={props.connected} />
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_bottom() {
        const hidden = createMemo(() => api.kv.get("tips_hidden", false))
        const first = createMemo(() => api.state.session.count() === 0)
        const connected = createMemo(() =>
          api.state.provider.some(
            (item) => item.id !== "redcode" || Object.values(item.models).some((model) => model.cost?.input !== 0),
          ),
        )
        const show = createMemo(() => (!first() || !connected()) && !hidden())
        return <View api={api} hidden={hidden()} show={show()} connected={connected()} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
