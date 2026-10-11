import type { AssistantMessage, Message } from "@redcode-ai/sdk/v2"
import { USD_TO_CNY } from "@redcode-ai/core/currency"
import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-context"

// 260615 Red: DeepSeek/Xiaomi/StepFun costs are already in CNY (official pricing), only USD providers need conversion
// 260827 Red 币种判定改读 model.cost.currency（provider.ts 落定价时写入）：CNY_PRICING 表与
// config.cost.currency 两条路都会标。名单版每加一个 CNY provider 必漏（stepfun-step-plan 栽过），
// 与 home/footer.tsx 260730 的改法对齐。
// 260904 cc 汇率的四份拷贝已合并到 @redcode-ai/core/currency，改汇率只改那一处。

const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
})
const moneyUsd = new Intl.NumberFormat("zh-CN", {
 style: "currency",
 currency: "USD",
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

// 261011 Red 显示档位改绝对 token 值（哥哥拍板）：<220k 绿、220-280k 黄、280-320k 橙、
// ≥320k 红。不再由引擎 level 的比例线驱动——360k 兜底下 soft=259k/prune=317k，
// 200 多 k 就漂橙天天扎眼，颜色是给自己看的心率表，分档听用户的。
const LEVEL_COLOR = {
  ok: "#66bb6a", // 绿：<220k
  soft: "#ffb300", // 黄：220-280k
  prune: "#ff9100", // 橙：280-320k
  compact: "#ff5252", // 红：≥320k
}

export function barColor(context: number | null | undefined): string {
  if ((context ?? 0) >= 320_000) return LEVEL_COLOR.compact
  if ((context ?? 0) >= 280_000) return LEVEL_COLOR.prune
  if ((context ?? 0) >= 220_000) return LEVEL_COLOR.soft
  return LEVEL_COLOR.ok
}

// 261010 Red 上下文取主会话请求；会话累计用量则始终包括摘要调用。
export function contextSource(messages: ReadonlyArray<Message>) {
  return messages.findLast((item): item is AssistantMessage =>
    item.role === "assistant" && !item.summary && item.tokens.output > 0)
}

// 261011 Red 会话累计（Session total）优先读服务端会话行聚合：msg() 只是分页已
// 加载子集，长会话下能比真实累计小一个数量级（本机现场 1.8 千万 vs 1.3 亿）。
// 口径与 GUI session-context-metrics.ts 的 SessionAggregate 一致（260930 同款修复），
// 命中率等比率仍按已加载消息算（聚合行没有 miss 分桶）。聚合缺失时退回子集累计。
export function sessionUsage(
  messages: ReadonlyArray<Message>,
  aggregate?: { tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } },
) {
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
  for (const m of messages) {
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
  return {
    output: sessionTotalOutput,
    reasoning: sessionTotalReasoning,
    cacheRead: sumRead,
    cacheMiss: sumMiss,
    cacheWrite: sumWrite,
    cacheHit: cacheDenom > 0 && sumRead > 0 ? Math.round((sumRead / cacheDenom) * 1000) / 10 : null,
    sessionTotal: aggregate?.tokens
      ? aggregate.tokens.input +
        aggregate.tokens.output +
        aggregate.tokens.reasoning +
        aggregate.tokens.cache.read +
        aggregate.tokens.cache.write
      : sessionTotalInput + sessionTotalOutput + sessionTotalReasoning + sumRead + sumWrite,
  }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    const last = contextSource(msg())
    const usage = sessionUsage(msg(), session())
    if (!last) {
      return {
        tokens: 0,
        input: 0,
        percent: null,
        context: null as number | null,
        limit: null as number | null,
        level: undefined as string | undefined,
        decodeRate: null as number | null,
        firstChunkMs: null as number | null,
        model: null as string | null,
        provider: null as string | null,
        providerID: null as string | null,
        costCurrency: null as "USD" | "CNY" | null,
       // 260930 Red 分币种账直接来自 session 行聚合（服务端 projector 按 part 的 currency
       // 分桶）。null = 未回填的旧行，此时 costCurrency 仍是「当前模型币种」的旧启发式——
       // 会话中途换过模型它就错，只作过渡期兜底。
       costBuckets: (() => {
         const s = session()
         if (s?.costCny === undefined && s?.costUsd === undefined) return null
         return { cny: s?.costCny ?? 0, usd: s?.costUsd ?? 0 }
       })(),
        messageCount: msg().length,
        ...usage,
      }
    }

    const tokens =
      last.tokens.total ??
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const prov = props.api.state.provider.find((item) => item.id === last.providerID)
    const modelInfo = prov?.models[last.modelID]
    const modelName = modelInfo?.name ?? last.modelID
    return {
      tokens,
      input: last.tokens.input,
      ...usage,
      costBuckets: undefined,
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
      // 260827 Red 币种判定数据源：model 报价上的 currency 标记（无标记 = USD，显示时折算）
      costCurrency: (modelInfo?.cost as { currency?: "USD" | "CNY" } | undefined)?.currency ?? null,
      messageCount: msg().length,
    }
  })

 // 260930 Red 分桶优先：每桶按原币种显示（「¥69.21 + $0.30」），不换算不混算。
 // 桶缺失的旧行退回「当前模型币种 + 全局折 CNY」的旧口径——那是 260615/260827 两轮
 // 都没根治的启发式，只作过渡期兜底，回填完成后随旧行一起退休。
 const costLabel = createMemo(() => {
   const buckets = state().costBuckets
   if (!buckets) return money.format(state().costCurrency === "CNY" ? cost() : cost() * USD_TO_CNY)
   const parts: string[] = []
   if (buckets.cny > 0) parts.push(money.format(buckets.cny))
   if (buckets.usd > 0) parts.push(moneyUsd.format(buckets.usd))
   return parts.length > 0 ? parts.join(" + ") : money.format(0)
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
          <span style={{ fg: barColor(state().context) }}>{compact(state().context!)}</span> / {compact(state().limit!)} ·{" "}
          <span style={{ fg: barColor(state().context) }}>{percentLabel()}</span>
        </text>
        <text>
          {"  "}
          <span style={{ fg: barColor(state().context) }}>{bar(state().percent ?? 0).filled}</span>
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
        out <span style={{ fg: tokenColor.output }}>{state().output.toLocaleString()}</span>
      </text>
      <Show when={state().reasoning > 0}>
        <text fg={theme()?.textMuted}>
          reason <span style={{ fg: tokenColor.reasoning }}>{state().reasoning.toLocaleString()}</span>
        </text>
      </Show>
      <Show when={state().cacheRead > 0 || state().cacheMiss > 0 || state().cacheWrite > 0}>
        {/* 260826 Red 隐藏 in 行：DeepSeek 输入=命中+未命中恒等，in(末轮 input≈cache.miss) 恒 0 纯误导——
            未命中总量 = cache.write + cache.miss（互斥双桶，read+miss+write 含全部输入），
            直接显示 hit/miss 与 GUI 上下文面板、usage-dashboard v0.1.2 同语义 */}
        <text fg={theme()?.textMuted}>
          hit <span style={{ fg: tokenColor.cacheRead }}>{state().cacheRead.toLocaleString()}</span> / miss{" "}
          <span style={{ fg: tokenColor.cacheWrite }}>
            {(state().cacheWrite + (state().cacheMiss ?? 0)).toLocaleString()}
          </span>
        </text>
      </Show>
     <text fg={theme()?.textMuted}>
       <span style={{ fg: tokenColor.cost }}>{costLabel()}</span> · {`${state().messageCount} msgs`}
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
