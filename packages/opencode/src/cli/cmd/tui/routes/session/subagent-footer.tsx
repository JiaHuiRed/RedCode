import { createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { AssistantMessage } from "@redcode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { useCommandShortcut, useOpencodeKeymap } from "../../keymap"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const session = createMemo(() => sync.session.get(route.sessionID))

  const subagentInfo = createMemo(() => {
    const s = session()
    if (!s) return { label: "Subagent", index: 0, total: 0 }
    const agentMatch = s.title.match(/@(\w+) subagent/)
    const label = agentMatch ? Locale.titlecase(agentMatch[1]) : "Subagent"

    if (!s.parentID) return { label, index: 0, total: 0 }

    const siblings = sync.data.session
      .filter((x) => x.parentID === s.parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
    const index = siblings.findIndex((x) => x.id === s.id)

    return { label, index: index + 1, total: siblings.length }
  })

  const usage = createMemo(() => {
    const msg = messages()
    // 260612 Red session-aggregate cache rate
    // 260614 fix: cache hit = read / (read + miss). DeepSeek write=0 so use cache.miss.
    // Fallback to input for providers that don't return miss metadata.
    let sumRead = 0, sumMiss = 0, sumWrite = 0, sumInput = 0
    for (const m of msg) {
      if (m.role === "assistant") {
        sumRead += m.tokens.cache.read
        sumMiss += m.tokens.cache.miss ?? 0
        sumWrite += m.tokens.cache.write
        sumInput += m.tokens.input
      }
    }
    if (sumRead <= 0) return
    const cacheDenom = sumRead + (sumMiss || sumWrite || sumInput)
    const cacheHitPct = Math.round((sumRead / cacheDenom) * 1000) / 10
    return { cache: `Cache: ${cacheHitPct}%` }
  })

  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()
  const parentShortcut = useCommandShortcut("session.parent")
  const previousShortcut = useCommandShortcut("session.child.previous")
  const nextShortcut = useCommandShortcut("session.child.next")
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  useTerminalDimensions()

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text}>
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().total > 0}>
              <text style={{ fg: theme.textMuted }}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {item().cache}
                </text>
              )}
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.parent")}
              backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Parent <span style={{ fg: theme.textMuted }}>{parentShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.previous")}
              backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Prev <span style={{ fg: theme.textMuted }}>{previousShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.next")}
              backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Next <span style={{ fg: theme.textMuted }}>{nextShortcut()}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}
