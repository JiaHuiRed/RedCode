import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, For, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"

const id = "internal:sidebar-todo"

// 260710 Red 层级子任务：按 parent_id 链条算缩进层级，防环/防越界兜个上限
const MAX_DEPTH = 5
function depthOf(item: { id?: string; parent_id?: string }, byId: Map<string, { id?: string; parent_id?: string }>) {
  let depth = 0
  let current = item
  const seen = new Set<string>()
  while (current.parent_id && depth < MAX_DEPTH) {
    if (current.id && seen.has(current.id)) break
    if (current.id) seen.add(current.id)
    const parent = byId.get(current.parent_id)
    if (!parent) break
    depth++
    current = parent
  }
  return depth
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const byId = createMemo(
    () =>
      new Map(
        list()
          .filter((item) => item.id)
          .map((item) => [item.id as string, item]),
      ),
  )
  const show = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))

  return (
    <Show when={show()}>
      {/* 260615 Red section with border title */}
      <box
        border={["top"]}
        borderColor={theme().borderSubtle ?? theme().textMuted}
        title={` Todo ${list().filter((i) => i.status === "completed").length}/${list().length} `}
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
            {(item) => <TodoItem status={item.status} content={item.content} depth={depthOf(item, byId())} />}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
