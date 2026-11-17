import type { AssistantMessage, ContextSnapshot, Message } from "@redcode-ai/sdk/v2"
import type { TuiPluginApi } from "@redcode-ai/plugin/tui"
import { useBindings } from "@tui/keymap"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"

// 261104 Red 同一条 assistant 可在流式过程中多次更新；只在完成后的稳定身份变化时刷新。
export function snapshotRequestKey(sessionID: string, messages: readonly Message[]): string {
  const last = messages.findLast(
    (item): item is AssistantMessage => item.role === "assistant" && !item.summary && !!item.time.completed,
  )
  return JSON.stringify([sessionID, last?.id, last?.time.completed, last?.tokens.context])
}

export function snapshotGroups(snapshot: ContextSnapshot) {
  return [
    { id: "system", label: "System", tokens: snapshot.system.tokens, items: snapshot.system.segments },
    { id: "tools", label: "Tools", tokens: snapshot.tools.tokens, items: snapshot.tools.top },
    { id: "messages", label: "Messages", tokens: snapshot.messages.tokens, items: snapshot.messages.byRole },
  ].map((group) => ({
    ...group,
    percent: snapshot.total > 0 ? Math.round((group.tokens / snapshot.total) * 100) : undefined,
  }))
}

// 261104 Red 侧栏内容宽 42 - border 2 - padding 2 - paddingRight 1 = 37 列；明细行是
// 4 空格缩进 + label + 1 空格 + compact(tokens)（最长约 6 字符）。后端 label 上限 48
// 字符（CJK 双宽可达 96 列），不裁就会换行成 2–3 行、把展开面板撑高。按显示宽度裁到
// 26 列：37 - 4 - 1 - 6，保证单行放得下。
const LABEL_COLUMNS = 26
export function fitLabel(label: string): string {
  if (Bun.stringWidth(label) <= LABEL_COLUMNS) return label
  let text = ""
  let width = 0
  for (const char of label) {
    const next = Bun.stringWidth(char)
    if (width + next > LABEL_COLUMNS - 1) break
    text += char
    width += next
  }
  return text + "…"
}

export function ContextComposition(props: {
  api: TuiPluginApi
  sessionID: string
  messages: readonly Message[]
  compact: (value: number) => string
  load: (sessionID: string) => Promise<{ data?: ContextSnapshot; response: Response }>
}) {
  const theme = () => props.api.theme.current
  const [open, setOpen] = createSignal(false)
  const [detail, setDetail] = createSignal<readonly string[]>([])
  // 261104 Red 键盘等价操作：侧栏折叠件此前只有 onMouseDown。键盘展开时三组明细
  // 一并展示（一次看全，收起时清空），鼠标仍可逐组开合；键位走 keybind 配置
  // （默认 <leader>i），改键不用动代码。
  const toggle = () => {
    setOpen((value) => {
      setDetail(value ? [] : ["system", "tools", "messages"])
      return !value
    })
  }
  // 鼠标只切开合，保留逐组开合的原有手感；键盘走 toggle 一次看全。
  const toggleOpen = () => {
    setOpen((value) => {
      if (value) setDetail([])
      return !value
    })
  }
  const toggleGroup = (id: string) => {
    setDetail((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }
  useBindings(() => ({
    commands: [
      {
        name: "sidebar.composition.toggle",
        title: "Inspect context composition",
        category: "Context",
        run: toggle,
      },
    ],
    bindings: props.api.tuiConfig.keybinds.gather("sidebar", ["sidebar.composition.toggle"]),
  }))
  let cached: { key: string; data: ContextSnapshot } | undefined
  const pending = new Map<string, Promise<{ key: string; data?: ContextSnapshot; error?: string }>>()
  const request = createMemo(() => open() ? snapshotRequestKey(props.sessionID, props.messages) : false)
  const [snapshot] = createResource(request, (key) => {
    if (cached?.key === key) return Promise.resolve(cached)
    const existing = pending.get(key)
    if (existing) return existing
    const work = (async () => {
      const [sessionID] = JSON.parse(key) as [string]
      try {
        const result = await props.load(sessionID)
        if (!result.data) return { key, error: result.response.status === 404 ? "暂无构成快照" : "读取失败，收起后重试" }
        const value = { key, data: result.data }
        if (request() === key) cached = value
        return value
      } catch {
        // 261104 Red 快照是可选观测数据，网络失败不应拖垮侧栏。
        return { key, error: "读取失败，收起后重试" }
      }
    })().finally(() => pending.delete(key))
    pending.set(key, work)
    return work
  })
  const current = createMemo(() => {
    const result = snapshot()
    return result?.key === request() ? result : undefined
  })

  return (
    <box flexDirection="column">
      <box onMouseDown={toggleOpen}>
        <text fg={theme().textMuted}>
          {open() ? "▾" : "▸"} Composition
          <Show when={open() && !snapshot.loading && current()?.data}>
            {(value) => <> · estimate {props.compact(value().total)}</>}
          </Show>
        </text>
      </box>
      <Show when={open()}>
        <Show when={!snapshot.loading} fallback={<text fg={theme().textMuted}>  Loading…</text>}>
          <Show when={current()?.data} fallback={<text fg={theme().textMuted}>  {current()?.error ?? "暂无构成快照"}</text>}>
            {(value) => (
              <box flexDirection="column">
                <For each={snapshotGroups(value())}>
                  {(group) => (
                    <box flexDirection="column">
                      <box onMouseDown={() => toggleGroup(group.id)}>
                        <text fg={theme().textMuted}>
                          {"  "}{detail().includes(group.id) ? "▾" : "▸"} {group.label} {props.compact(group.tokens)}
                          {group.percent === undefined ? "" : ` · ${group.percent}%`}
                        </text>
                      </box>
                      <Show when={detail().includes(group.id)}>
                        <For each={group.items}>
                          {(item) => <text fg={theme().textMuted}>{"    "}{fitLabel(item.label)} {props.compact(item.tokens)}</text>}
                        </For>
                      </Show>
                    </box>
                  )}
                </For>
                <text fg={theme().textMuted}>  captured {new Date(value().time).toLocaleString()}</text>
              </box>
            )}
          </Show>
        </Show>
      </Show>
    </box>
  )
}
