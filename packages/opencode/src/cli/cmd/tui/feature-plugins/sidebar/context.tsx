import type { AssistantMessage } from "@redcode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-context"

// 260615 Red: DeepSeek/Xiaomi/StepFun costs are already in CNY (official pricing), only USD providers need conversion
// 260731 Karina 名单补齐 stepfun-step-plan/zhipuai/openox（provider.ts CNY_PRICING 的 provider 全集），
// 汇率 6.76 → 6.75（哥哥给定）。此名单与 CNY_PRICING 同步维护，加 provider 必漏。
const USD_TO_CNY = 6.75
const CNY_PROVIDERS = new Set([
  "deepseek",
  "xiaomi",
  "stepfun",
  "stepfun-step-plan",
  "zhipuai",
  "opencode-go",
  "openox", // 260731 Karina openox 报价是人民币（见 provider.ts CNY_PRICING）
])

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

// 260819 cc 上下文窗口用紧凑记法，侧边栏只有 42 列，185,925 / 1,000,000 这种写法一行放不下
export function compact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`
  }
  if (n >= 1_000) {
    const k = n / 1_000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
  }
  return String(n)
}

const BAR_WIDTH = 24
export function bar(percent: number): { filled: string; rest: string } {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.min(BAR_WIDTH, Math.round((clamped / 100) * BAR_WIDTH))
  return { filled: "█".repeat(filled), rest: "░".repeat(BAR_WIDTH - filled) }
}

// 绿→黄→红：85% 以上就该考虑压缩了，颜色先于数字给出信号
export function barColor(percent: number): string {
  if (percent >= 85) return "#ff5252"
  if (percent >= 60) return "#ffb300"
  return "#66bb6a"
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
        context: null as number | null,
        limit: null as number | null,
        model: null as string | null,
        provider: null as string | null,
        providerID: null as string | null,
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
    // 260614 Red: cache hit = read / (read + miss). For DeepSeek, cache.write=0
    // so use cache.miss from metadata directly; fallback to write, then to input for other providers.
    // 260707 Red fix: session.ts's DeepSeek cache-cap fallback (260705) can route the real
    // miss/fresh tokens into cache.write instead of cache.miss depending on which raw metadata
    // field the SDK response populated for a given step. miss and write never double-count the
    // same tokens (tokens.cache.miss === tokens.input by construction in session.ts), so summing
    // read+miss+write gives the true total instead of an either/or pick that silently drops
    // whichever bucket the buggy path skipped — this was inflating hit% (e.g. 99% vs the real ~96%).
    let sumRead = 0, sumMiss = 0, sumWrite = 0
    let sessionTotalInput = 0, sessionTotalOutput = 0, sessionTotalReasoning = 0
    for (const m of msg()) {
      if (m.role === "assistant") {
        sumRead += m.tokens.cache.read
        sumMiss += m.tokens.cache.miss ?? 0
        sumWrite += m.tokens.cache.write
        sessionTotalInput += m.tokens.input
        sessionTotalOutput += m.tokens.output
        sessionTotalReasoning += m.tokens.reasoning
      }
    }
    const cacheDenom = sumRead + sumMiss + sumWrite
    const cacheHit = cacheDenom > 0 && sumRead > 0 ? Math.round((sumRead / cacheDenom) * 1000) / 10 : null
    const sessionTotal = sessionTotalInput + sessionTotalOutput + sessionTotalReasoning + sumRead + sumWrite
    return {
      tokens,
      input: last.tokens.input,
      output: last.tokens.output,
      reasoning: last.tokens.reasoning,
      cacheRead: sumRead,
      cacheMiss: sumMiss,
      cacheWrite: sumWrite,
      cacheHit,
      // 260819 cc 口径修复：percent 原来拿 tokens（= last.tokens.total）除上下文窗口，而 total 在
      // processor 里跨 step 累加（260706 为让 cost/缓存命中率对账），一次 assistant 消息含几次工具
      // 往返就累加几次请求的 total —— 长工具链下显示成上下文的十几倍。下面 percentLabel 里那句
      // p > 200 就是这个问题被看见过但没改口径的痕迹。改用 tokens.context（最后一个 step 的提示词
      // 总量，恒不累加）。历史消息没有这个字段，此时整块不显示，等本会话下一轮请求写入。
      context: last.tokens.context ?? null,
      limit: modelInfo?.limit.context ?? null,
      percent:
        last.tokens.context !== undefined && modelInfo?.limit.context
          ? Math.round((last.tokens.context / modelInfo.limit.context) * 100)
          : null,
      model: modelName,
      provider: prov?.name ?? last.providerID,
      providerID: last.providerID,
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
      <box height={1} />
      <text fg={theme()?.textMuted}>Context window</text>
      <Show
        when={state().context !== null && state().limit !== null}
        fallback={
          <text fg={theme()?.textMuted}>
            {"  "}
            <span style={{ fg: theme()?.textMuted }}>暂无（本会话下一轮请求后显示）</span>
          </text>
        }
      >
        <text fg={theme()?.textMuted}>
          {"  "}
          <span style={{ fg: barColor(state().percent ?? 0) }}>{compact(state().context!)}</span> /{" "}
          {compact(state().limit!)} · <span style={{ fg: barColor(state().percent ?? 0) }}>{percentLabel()}</span>
        </text>
        <text>
          {"  "}
          <span style={{ fg: barColor(state().percent ?? 0) }}>{bar(state().percent ?? 0).filled}</span>
          <span style={{ fg: theme()?.textMuted }}>{bar(state().percent ?? 0).rest}</span>
        </text>
      </Show>
      <box height={1} />
      <text fg={theme()?.textMuted}>
        Session total <span style={{ fg: tokenColor.total }}>{state().sessionTotal.toLocaleString()}</span>
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
        <span style={{ fg: tokenColor.cost }}>{money.format(CNY_PROVIDERS.has(state().providerID ?? "") ? cost() : cost() * USD_TO_CNY)}</span> · {`${state().messageCount} msgs`}
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
