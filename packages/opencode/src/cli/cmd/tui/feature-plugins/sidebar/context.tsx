import type { AssistantMessage } from "@redcode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-context"

// 260613 Red costs are in USD; convert to CNY for display
const USD_TO_CNY = 7.2

const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
})

const tokenColor = {
  current: "#ff5252",
  total: "#ce93d8",
  input: "#ffb300",
  output: "#66bb6a",
  reasoning: "#ff9100",
  cacheRead: "#40c4ff",
  cacheWrite: "#ab47bc",
  cost: "#ff4081",
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDuration(updated: number): string {
  const diff = Date.now() - updated
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheHit: null,
        percent: null,
        model: null as string | null,
        provider: null as string | null,
        messageCount: msg().length,
        sessionTotal: 0,
      }
    }

    const tokens =
      last.tokens.total ??
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const prov = props.api.state.provider.find((item) => item.id === last.providerID)
    const modelInfo = prov?.models[last.modelID]
    const modelName = modelInfo?.name ?? last.modelID
    // 260612 Red session-aggregate cache rate (not last-turn-only which is always ~99%)
    // 260614 fix: cache hit = read / (read + miss). For DeepSeek, cache.write=0
    // so use cache.miss from metadata directly; fallback to write, then to input for other providers.
    let sumRead = 0, sumMiss = 0, sumWrite = 0, sumInput = 0
    let sessionTotalInput = 0, sessionTotalOutput = 0, sessionTotalReasoning = 0
    for (const m of msg()) {
      if (m.role === "assistant") {
        sumRead += m.tokens.cache.read
        sumMiss += m.tokens.cache.miss ?? 0
        sumWrite += m.tokens.cache.write
        sumInput += m.tokens.input
        sessionTotalInput += m.tokens.input
        sessionTotalOutput += m.tokens.output
        sessionTotalReasoning += m.tokens.reasoning
      }
    }
    const cacheDenom = sumRead + (sumMiss || sumWrite || sumInput)
    const cacheHit = cacheDenom > 0 && sumRead > 0 ? Math.round((sumRead / cacheDenom) * 1000) / 10 : null
    const sessionTotal = sessionTotalInput + sessionTotalOutput + sessionTotalReasoning + sumRead + sumWrite
    return {
      tokens,
      input: last.tokens.input,
      output: last.tokens.output,
      reasoning: last.tokens.reasoning,
      cacheRead: sumRead,
      cacheWrite: sumWrite,
      cacheHit,
      percent: modelInfo?.limit.context ? Math.round((tokens / modelInfo.limit.context) * 100) : null,
      model: modelName,
      provider: prov?.name ?? last.providerID,
      messageCount: msg().length,
      sessionTotal,
    }
  })

  const created = createMemo(() => session()?.time?.created)
  const updated = createMemo(() => session()?.time?.updated)
  const agent = createMemo(() => session()?.agent)

  const percentLabel = createMemo(() => {
    const p = state().percent
    if (p === null) return "?"
    if (p > 200) return `${p}% ⚠`
    return `${p}%`
  })

  return (
    <box>
      <text fg={theme()?.text}>
        <b>Context</b>
      </text>
      <Show when={state().provider}>
        <text fg={theme()?.textMuted}>
          <span style={{ fg: theme()?.accent }}>●</span> <span style={{ fg: theme()?.secondary }}>{state().provider}</span>
        </text>
      </Show>
      <Show when={state().model}>
        <text fg={theme()?.primary}>  {state().model}</text>
      </Show>
      <text fg={theme()?.textMuted}>
        <span style={{ fg: tokenColor.current }}>{state().tokens.toLocaleString()}</span> tokens · {percentLabel()}
      </text>
      <text fg={theme()?.textMuted}>
        Total <span style={{ fg: tokenColor.total }}>{state().sessionTotal.toLocaleString()}</span> tokens
      </text>
      <text fg={theme()?.textMuted}>
        in <span style={{ fg: tokenColor.input }}>{state().input.toLocaleString()}</span> · out <span style={{ fg: tokenColor.output }}>{state().output.toLocaleString()}</span>
      </text>
      <Show when={state().reasoning > 0}>
        <text fg={theme()?.textMuted}>
          reason <span style={{ fg: tokenColor.reasoning }}>{state().reasoning.toLocaleString()}</span>
        </text>
      </Show>
      <Show when={state().cacheRead > 0 || state().cacheWrite > 0}>
        <text fg={theme()?.textMuted}>
          cache{' '}
          <Show when={state().cacheWrite > 0} fallback={
            <span style={{ fg: tokenColor.cacheRead }}>{state().cacheRead.toLocaleString()}</span>
          }>
            <span style={{ fg: tokenColor.cacheRead }}>{state().cacheRead.toLocaleString()}</span> /{' '}
            <span style={{ fg: tokenColor.cacheWrite }}>{state().cacheWrite.toLocaleString()}</span>
          </Show>
        </text>
      </Show>
      <text fg={theme()?.textMuted}>
        <span style={{ fg: tokenColor.cost }}>{money.format(cost() * USD_TO_CNY)}</span> · {`${state().messageCount} msgs`}
      </text>
      <Show when={agent()}>
        <text fg={theme()?.textMuted}>
          agent <span style={{ fg: theme()?.accent }}>{agent()}</span>
        </text>
      </Show>
      <box height={1} />
      <Show when={created()}>
        <text fg={theme()?.textMuted}>created {formatTime(created()!)}</text>
      </Show>
      <Show when={updated()}>
        <text fg={theme()?.textMuted}>active {formatDuration(updated()!)}</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
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
