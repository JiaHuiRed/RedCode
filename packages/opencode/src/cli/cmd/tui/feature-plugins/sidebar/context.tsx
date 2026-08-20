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
  speed: "#4dd0e1",
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

// 260819 cc 首字延迟：秒级用 s，否则 ms —— 侧边栏只有 42 列，2423ms 比 2.4s 长且没更有用
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`
}

const BAR_WIDTH = 24
export function bar(percent: number): { filled: string; rest: string } {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.min(BAR_WIDTH, Math.round((clamped / 100) * BAR_WIDTH))
  return { filled: "█".repeat(filled), rest: "░".repeat(BAR_WIDTH - filled) }
}

// 260819 cc 颜色由**引擎判定的档位**驱动，不是百分比。
//
// 为什么不按百分比：档位是相对 ceiling() = min(硬顶, usable) 算的，而进度条的分母是
// 模型标称的 context window，两者不是一个数。以 step-3.7-flash 为例 context=256k、
// usable≈224k，三条线落在 134k/179k/224k，换算成进度条就是 52%/70%/88% —— 按 60/85
// 上色会比引擎实际动手慢半拍（soft 早在 52% 就过了，prune 在 70% 就已在裁工具输出）。
// 拿它当「要不要手动 compress」的依据会误判。
//
// ceiling 需要 maxOutputTokens(model) 那张按模型家族匹配的表，在 TUI 侧复刻等于两处
// 维护、加一个模型漏一处颜色就悄悄偏，所以让服务端算好经 tokens 一起发过来。
const LEVEL_COLOR: Record<string, string> = {
  ok: "#66bb6a", // 绿：引擎不会动手
  soft: "#ffb300", // 黄：只记一条提示，刻意不动前缀
  prune: "#ff9100", // 橙：开始裁陈旧工具输出（本地改写，不花钱）
  compact: "#ff5252", // 红：真正的摘要压缩，重写前缀 + 一次模型调用
}

export function barColor(level: string | undefined): string {
  return LEVEL_COLOR[level ?? "ok"] ?? LEVEL_COLOR.ok
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
        level: undefined as string | undefined,
        decodeRate: null as number | null,
        firstChunkMs: null as number | null,
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
    let sumRead = 0,
      sumMiss = 0,
      sumWrite = 0
    let sessionTotalInput = 0,
      sessionTotalOutput = 0,
      sessionTotalReasoning = 0
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
      level: last.contextLevel,
      // 260819 cc 解码速率与首字延迟。数据早就在库里（message-v2.ts:500 的注释：
      // created→firstChunk = 等第一个字（排队/预填），firstChunk→completed = 吐字），
      // 埋点见 processor.ts 的 llm.ttft，分析脚本 script/ttft.ts。这里只是把它显示出来。
      //
      // 分子必须是 output + reasoning：session.ts:460 把 output 定义成
      // outputTokens - reasoningTokens，只用 output 会把思考的字漏掉 —— 对 DeepSeek
      // 这类长思考模型会严重低估速率。
      //
      // 分母必须从 firstChunk 起算，不能用 created：那段是排队/预填，长上下文下能把
      // 60 tok/s 稀释成 20，测出来的就不是解码速度而是排队时间。
      ...(() => {
        const t = last.time
        const decoded = last.tokens.output + last.tokens.reasoning
        const ms = t.firstChunk && t.completed ? t.completed - t.firstChunk : 0
        return {
          decodeRate: ms > 0 && decoded > 0 ? Math.round((decoded / ms) * 1000 * 10) / 10 : null,
          firstChunkMs: t.firstChunk ? t.firstChunk - t.created : null,
        }
      })(),
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
          <span style={{ fg: theme()?.accent }}>●</span>{" "}
          <span style={{ fg: theme()?.secondary }}>{state().provider}</span>
        </text>
      </Show>
      <Show when={state().model}>
        <text fg={theme()?.primary}> {state().model}</text>
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
          <span style={{ fg: barColor(state().level) }}>{compact(state().context!)}</span> / {compact(state().limit!)} ·{" "}
          <span style={{ fg: barColor(state().level) }}>{percentLabel()}</span>
        </text>
        <text>
          {"  "}
          <span style={{ fg: barColor(state().level) }}>{bar(state().percent ?? 0).filled}</span>
          <span style={{ fg: theme()?.textMuted }}>{bar(state().percent ?? 0).rest}</span>
        </text>
      </Show>
      <box height={1} />
      <text fg={theme()?.textMuted}>
        Session total <span style={{ fg: tokenColor.total }}>{state().sessionTotal.toLocaleString()}</span>
      </text>
      {/* 260819 cc 解码速率 · 首字延迟。两段分开显示是刻意的：它们是不同的东西 ——
          首字慢 = 排队/预填（供应商侧负载、上下文长度），解码慢 = 吐字本身。
          混成一个"总速度"会让这两种完全不同的问题看起来一样。 */}
      <Show when={state().decodeRate !== null || state().firstChunkMs !== null}>
        <text fg={theme()?.textMuted}>
          <Show when={state().decodeRate !== null}>
            <span style={{ fg: tokenColor.speed }}>{state().decodeRate}</span> tok/s
          </Show>
          <Show when={state().decodeRate !== null && state().firstChunkMs !== null}> · </Show>
          <Show when={state().firstChunkMs !== null}>首字 {formatMs(state().firstChunkMs!)}</Show>
        </text>
      </Show>
      <text fg={theme()?.textMuted}>
        in <span style={{ fg: tokenColor.input }}>{state().input.toLocaleString()}</span> · out{" "}
        <span style={{ fg: tokenColor.output }}>{state().output.toLocaleString()}</span>
      </text>
      <Show when={state().reasoning > 0}>
        <text fg={theme()?.textMuted}>
          reason <span style={{ fg: tokenColor.reasoning }}>{state().reasoning.toLocaleString()}</span>
        </text>
      </Show>
      <Show when={state().cacheRead > 0 || state().cacheWrite > 0}>
        <text fg={theme()?.textMuted}>
          cache{" "}
          <Show
            when={state().cacheWrite > 0}
            fallback={<span style={{ fg: tokenColor.cacheRead }}>{state().cacheRead.toLocaleString()}</span>}
          >
            <span style={{ fg: tokenColor.cacheRead }}>{state().cacheRead.toLocaleString()}</span> /{" "}
            <span style={{ fg: tokenColor.cacheWrite }}>{state().cacheWrite.toLocaleString()}</span>
          </Show>
        </text>
      </Show>
      <text fg={theme()?.textMuted}>
        <span style={{ fg: tokenColor.cost }}>
          {money.format(CNY_PROVIDERS.has(state().providerID ?? "") ? cost() : cost() * USD_TO_CNY)}
        </span>{" "}
        · {`${state().messageCount} msgs`}
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
