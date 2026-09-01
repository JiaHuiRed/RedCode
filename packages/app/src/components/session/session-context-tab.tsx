import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useQuery } from "@tanstack/solid-query"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { checksum } from "@redcode-ai/core/util/encode"
import { findLast } from "@redcode-ai/core/util/array"
import { same } from "@/utils/same"
import { compareTime } from "@/utils/id"
import { Icon } from "@redcode-ai/ui/icon"
import { Accordion } from "@redcode-ai/ui/accordion"
import { StickyAccordionHeader } from "@redcode-ai/ui/sticky-accordion-header"
import { useFileComponent } from "@redcode-ai/ui/context/file"
import { Markdown } from "@redcode-ai/ui/markdown"
import { ScrollView } from "@redcode-ai/ui/scroll-view"
import type { Message, Part, ProviderQuota, UserMessage } from "@redcode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { findLastCompaction, getSessionContextMetrics } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"

// 260820 cc 真实构成三块的配色。刻意与下面 BREAKDOWN_COLOR 的 system 同色（都是 info）——
// 两块讲的是同一件事的估算版与实测版，颜色一致才看得出对应关系。
const INSPECT_COLOR = {
  system: "var(--syntax-info)",
  tools: "var(--syntax-warning)",
  messages: "var(--syntax-property)",
} as const

type InspectKey = keyof typeof INSPECT_COLOR

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

function Stat(props: { label: string; value: JSX.Element; color?: string }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium select-text" style={{ color: props.color ?? "var(--text-strong)" }}>
        {props.value}
      </div>
    </div>
  )
}

type QuotaWindowData = NonNullable<ProviderQuota["primary"]>
// 260831 Red hey-api 把数字字段生成为 number | "NaN" | "Infinity" | "-Infinity" 的 union，
//   归一化成 number 才能做百分比/时长/时间运算
type QuotaNumeric = number | "NaN" | "Infinity" | "-Infinity"
const quotaNum = (v: QuotaNumeric) => (typeof v === "number" ? v : 0)

// 260831 Red 额度进度条颜色分档：接近用完才告急，不然整页都是红色
const quotaColor = (percent: number) =>
  percent >= 90 ? "var(--syntax-critical)" : percent >= 60 ? "var(--syntax-warning)" : "var(--syntax-info)"

const quotaDuration = (minutes: number) =>
  minutes >= 1440 && minutes % 1440 === 0
    ? `${minutes / 1440}d`
    : minutes % 60 === 0
      ? `${minutes / 60}h`
      : `${minutes}m`

function QuotaWindow(props: { label: string; window?: QuotaWindowData }) {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-2 text-11-regular text-text-weak">
        <div>{props.label}</div>
        <Show when={props.window} fallback={<div class="text-text-weaker">—</div>}>
          {(window) => {
            const percent = quotaNum(window().usedPercent)
            return (
              <div class="flex items-baseline gap-1.5">
                <div class="text-12-medium select-text" style={{ color: quotaColor(percent) }}>
                  {percent}%
                </div>
                <div class="text-text-weaker">{quotaDuration(quotaNum(window().windowMinutes))}</div>
              </div>
            )
          }}
        </Show>
      </div>
      <Show when={props.window}>
        {(window) => {
          const percent = quotaNum(window().usedPercent)
          const resetAt = quotaNum(window().resetAt)
          return (
            <div class="flex flex-col gap-1">
              <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden">
                <div
                  class="h-full"
                  style={{
                    width: `${percent}%`,
                    "background-color": quotaColor(percent),
                  }}
                />
              </div>
              <Show when={resetAt > 0}>
                <div class="text-11-regular text-text-weaker">
                  {language.t("context.quota.resetsAt", {
                    time: new Date(resetAt * 1000).toLocaleString(language.intl(), {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  })}
                </div>
              </Show>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  // 260901 cc 这里原本是 `import { File } from "@redcode-ai/ui/file"` 直接用。
  //   app.tsx 把 File 改成动态加载之后，**这一处静态引入就是那个改动的漏底**：
  //   打包产物里 session-*.js 因此静态 import 了整个 file-*.js（447KB，含 @pierre/diffs
  //   334KB），于是「用到才加载」退化成「进会话就加载」。改成和其余 7 处消费方一样走
  //   useFileComponent()，静态边就断了。
  const fileComponent = useFileComponent()
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <Dynamic
      component={fileComponent}
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: Message
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.role} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const globalSync = useServerSync()
  // 260831 Red 额度是账号级事实（GlobalBus 广播 + bootstrap 首次拉取），直接从全局 store 读
  const quotaList = () => globalSync.data.provider_quota
  const providers = useProviders()
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync.data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      // 260814 Red 过滤边界改 compareTime（ID 回绕后字典序失真）
      const revertMsg = userMessages().find((m) => m.id === revert)
      if (!revertMsg) return userMessages()
      return userMessages().filter((m) => compareTime(m, revertMsg) < 0)
    },
    emptyUserMessages,
    { equals: same },
  )

  const metrics = createMemo(() => getSessionContextMetrics(messages(), [...providers.all().values()]))
  const ctx = createMemo(() => metrics().context)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  // 260706 Red: 子代理(Task/Agent 工具)创建的子 session 的 LLM 调用成本在 DeepSeek 平台真实计费，
  // 但原 metrics 只统计父 session 自身消息——面板显示"总成本"严重偏低。
  // 通过 SSE 全局事件流同步到 store 的子 session 消息汇总其 cost 一并显示。
  const childCost = createMemo(() => {
    const id = params.id
    if (!id) return 0
    let total = 0
    for (const s of sync.data.session) {
      if (s.parentID !== id) continue
      const msgs = sync.data.message[s.id]
      if (!msgs) continue
      for (const m of msgs) {
        if (m.role === "assistant") total += m.cost
      }
    }
    return total
  })

  const cost = createMemo(() => {
    const m = metrics()
    return formatter().cost(m.totalCost + childCost(), m.costCurrency)
  })

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  // 260715 Red: chat history loads lazily (40 msgs initial, +80 per scroll-up page — see
  // directory-sync.ts), but these stats sum whatever's currently in sync.data.message. Right
  // after opening a long session only a recent slice is loaded, so totals/cache-hit silently
  // undercount until the user scrolls to the top. Surface that instead of pretending it's exact.
  const hasMoreHistory = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, messages().length, systemPrompt()],
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          parts: sync.data.part as Record<string, Part[] | undefined>,
          input: c.input,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  // 260820 cc 真实构成：服务端在「请求真正发出去的那一刻」记下的快照
  // （session/context-snapshot.ts）。与上面那块估算的区别不是精度，是**范围**——
  // system 提示与 tool schema 这两块从来没到过客户端，估算器手里根本没有这两份数据，
  // 而它们恰恰是前缀里最大且最不透明的部分。
  //
  // 快照只在服务端内存、只留最后一轮：会话还没在本进程发过请求时是 404，那不是错误，
  // 按「暂无」显示。key 跟着最后一条 assistant 的 id 与 context 走，一轮请求落定才重取。
  const sdk = useSDK()
  const inspect = useQuery(() => ({
    queryKey: ["session", params.id ?? "", ctx()?.message.id ?? "", ctx()?.window ?? 0, "context-inspect"] as const,
    enabled: () => !!params.id,
    // 260822 cc **这一行是在修「模型一调工具，整个界面闪一下变成主题底色再回来」**。
    //
    // 上面这个 key 每轮都会变（带着最后一条 assistant 的 id 与 tokens.context，而
    // tokens.context 是服务端每个 step 覆写一次的）。solid-query 的 useQuery 内部就是
    // createResource：key 一变就成了一个「全新且无缓存」的 pending 查询，此时读 .data
    // （inspectGroups 里）会**向上抛给最近的 Suspense**。而最近的那个是 app.tsx:198
    // 包住**整个应用**的那一个，它的 fallback 是满屏 bg-background-base + Splash ——
    // 于是每次工具调用，整棵树被卸载换成一块满屏色块再重挂。伴随症状：CLS 爆表、
    // 没有任何长任务（不是算卡了，是真的换掉了）、正在输入的 IME 组合被强行提交成拼音。
    // 只在本 tab 激活时出现，因为侧栏 tab 内容是 <Show when={activeTab()===...}> 真卸载的。
    //
    // 保留上一轮数据即可让它永远不进入「无数据 pending」：换 key 时先拿旧快照顶着，
    // 新的取回来再替换。旧快照短暂偏一轮，远好过整个界面闪。
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const id = params.id
      if (!id) return null
      try {
        const result = await sdk.client.session.contextInspect({ sessionID: id })
        return result.data ?? null
      } catch {
        return null
      }
    },
  }))

  const inspectGroups = createMemo(() => {
    const snapshot = inspect.data
    if (!snapshot || snapshot.total <= 0) return []
    const groups: {
      key: InspectKey
      tokens: number
      count: number
      items: readonly { label: string; tokens: number }[]
    }[] = [
      {
        key: "system",
        tokens: snapshot.system.tokens,
        count: snapshot.system.segments.length,
        items: snapshot.system.segments,
      },
      { key: "tools", tokens: snapshot.tools.tokens, count: snapshot.tools.count, items: snapshot.tools.top },
      {
        key: "messages",
        tokens: snapshot.messages.tokens,
        count: snapshot.messages.count,
        items: snapshot.messages.byRole,
      },
    ]
    return groups
      .filter((group) => group.tokens > 0)
      .map((group) => ({ ...group, percent: Math.round((group.tokens / snapshot.total) * 1000) / 10 }))
  })

  // 260829 cc 快照现在会落盘（context-snapshot.ts），于是它可能来自几天前的一次请求。
  // 标着「真实构成」却不说是什么时候的，那是在误导——纯内存时它必然是本进程刚记的，
  // 不标时间尚可，落盘之后必须标。
  const inspectTime = createMemo(() => {
    const at = inspect.data?.time
    if (!at) return ""
    return new Date(at).toLocaleString(language.intl(), {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  })

  const inspectLabel = (key: InspectKey) => {
    if (key === "system") return language.t("context.inspect.system")
    if (key === "tools") return language.t("context.inspect.tools")
    return language.t("context.inspect.messages")
  }

  // 260715 Red: 每项固定分到不同的 --syntax-* token（同色的两处在网格里横向/纵向都不相邻，
  // 单列塌陷时也按数组序错开），标题类字段（会话名/创建时间）留中性色，其余全部上色。
  // 260805 Red 每项固定分到不同的 --syntax-* token（同色的两处在网格里横向/纵向都不相邻，
  // 单列塌陷时也按数组序错开），标题类字段（会话名/创建时间）留中性色，其余全部上色。
  // 260809 Red 输入 token 为 0 时用中性色——浅色主题下 syntax-string 是橙红，零值看着像报错
  const inputTokensColor = createMemo(() => (ctx()?.input ? "var(--syntax-string)" : undefined))

  const stats = [
    { label: "context.stats.session", value: () => info()?.title ?? params.id ?? "—" },
    { label: "context.stats.sessionID", value: () => params.id ?? "—", color: "var(--syntax-property)" },
    {
      label: "context.stats.messages",
      value: () => counts().all.toLocaleString(language.intl()),
      color: "var(--syntax-primitive)",
    },
    { label: "context.stats.provider", value: providerLabel, color: "var(--syntax-info)" },
    { label: "context.stats.model", value: modelLabel, color: "var(--syntax-string)" },
    {
      label: "context.stats.totalTokens",
      value: () => formatter().number(ctx()?.total),
      color: "var(--syntax-success)",
    },
    // 260821 Red：删除「上下文窗口」字段——输入框 tooltip 已显示窗口占用率，右侧重复。
    // 260822 cc 「上下文限制」与「使用率」也一并删掉，分工彻底切开：
    //   **窗口口径归输入框那个圆圈**（占用/上限/百分比 + 首字延迟 + 解码速率，都是"当下这一轮"），
    //   **会话账本归这里**（累计用量、构成、成本、元数据）。
    // 这两格原本就是 tooltip 第一行 `51,572 / 256,000 · 20%` 的分母与百分比，一字不差。
    // 腾出的位置换成两条同样"数据早就在线上、但从没显示过"的压缩机制字段（见下）。
    // 上面 totalTokens 那行仍是会话累计，标签本来就对，不动。
    { label: "context.stats.inputTokens", value: () => formatter().number(ctx()?.input), color: inputTokensColor() },
    {
      label: "context.stats.outputTokens",
      value: () => formatter().number(ctx()?.output),
      color: "var(--syntax-property)",
    },
    {
      label: "context.stats.reasoningTokens",
      value: () => formatter().number(ctx()?.reasoning),
      color: "var(--syntax-warning)",
    },
    {
      label: "context.stats.cacheTokens",
      value: () => {
        const c = ctx()
        if (!c || (c.cacheRead <= 0 && c.cacheWrite <= 0)) return "—"
        const hit = c.cacheHit != null ? ` (${formatter().percent(c.cacheHit)})` : ""
        return c.cacheWrite
          ? `${formatter().number(c.cacheRead)} / ${formatter().number(c.cacheWrite)}${hit}`
          : `${formatter().number(c.cacheRead)}${hit}`
      },
      color: "var(--syntax-info)",
    },
    // 260805 Red 单次交互命中率：最近一轮请求的缓存命中率，缓存被钉死时它两轮内就掉
    // 到 60~80%，而旁边累计值（cacheTokens 那格）那时候还没动。stalled 时标红告警。
    {
      label: "context.stats.turnCacheHit",
      value: () => {
        const c = ctx()
        if (c?.turnHitPct == null) return "—"
        return c.stalled ? `${formatter().percent(c.turnHitPct)} · 缓存未延伸` : `${formatter().percent(c.turnHitPct)}`
      },
      color: "var(--syntax-critical)",
    },
    {
      label: "context.stats.userMessages",
      value: () => counts().user.toLocaleString(language.intl()),
      color: "var(--syntax-success)",
    },
    {
      label: "context.stats.assistantMessages",
      value: () => counts().assistant.toLocaleString(language.intl()),
      color: "var(--syntax-type)",
    },
    { label: "context.stats.totalCost", value: cost, color: "var(--syntax-critical)" },
    {
      // 260831 cc 换掉原来的「上次压缩」与「自动压缩」两格（哥哥 260831 定）：前者绝大多数
      //   会话是个破折号，后者是**配置回显**而不是会话数据——压缩状态属于「状态」tab，不属于
      //   这本会话账本。换成真属于本会话的：平均每轮 = 总 token ÷ 用户消息数，比「总 token
      //   1638 万」更能说明这个会话有多重（该例约 102 万/轮）。
      label: "context.stats.avgPerTurn",
      value: () => {
        const turns = counts().user
        const total = ctx()?.total
        if (!turns || !total) return "—"
        return formatter().number(Math.round(total / turns))
      },
      color: "var(--syntax-warning)",
    },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    {
      label: "context.stats.lastActivity",
      value: () => formatter().time(ctx()?.message.time.created),
      color: "var(--syntax-constant)",
    },
  ] satisfies { label: string; value: () => JSX.Element; color?: string }[]

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const getParts = (id: string) => (sync.data.part[id] ?? []) as Part[]

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 pb-10 flex flex-col gap-10">
        <Show when={hasMoreHistory()}>
          <div class="flex items-start gap-2 border border-border-base rounded-md bg-surface-base px-3 py-2">
            <Icon name="warning" size="small" class="shrink-0 mt-0.5" style={{ color: "var(--syntax-warning)" }} />
            <div class="text-11-regular text-text-weak">
              {language.t("context.stats.partial", { count: counts().all.toLocaleString(language.intl()) })}
            </div>
          </div>
        </Show>
        <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
          <For each={stats}>
            {(stat) => (
              <Stat
                label={language.t(stat.label as Parameters<typeof language.t>[0])}
                value={stat.value()}
                color={stat.color}
              />
            )}
          </For>
        </div>

        <div class="flex flex-col gap-2 pr-2">
          <div class="text-12-regular text-text-weak">{language.t("context.quota.title")}</div>
          <Show
            when={quotaList().length > 0}
            fallback={<div class="text-11-regular text-text-weaker">{language.t("context.quota.empty")}</div>}
          >
            <div class="flex flex-col gap-4">
              <For each={quotaList()}>
                {(quota) => (
                  <div class="flex flex-col gap-2">
                    <div class="flex items-baseline justify-between gap-2">
                      <div class="text-11-regular text-text-weak">{quota.planType}</div>
                      <Show when={quota.accountID}>
                        {(accountID) => <div class="text-11-regular text-text-weaker select-text">{accountID()}</div>}
                      </Show>
                    </div>
                    <div class="flex flex-col gap-3">
                      <QuotaWindow label={language.t("context.quota.window.primary")} window={quota.primary} />
                      <QuotaWindow label={language.t("context.quota.window.secondary")} window={quota.secondary} />
                      <Show when={quota.reserve}>
                        {(reserve) => (
                          <QuotaWindow
                            label={
                              quota.reserveName
                                ? `${language.t("context.quota.window.reserve")} · ${quota.reserveName}`
                                : language.t("context.quota.window.reserve")
                            }
                            window={reserve()}
                          />
                        )}
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <Show
          when={inspectGroups().length > 0}
          fallback={
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.inspect.title")}</div>
              <div class="text-11-regular text-text-weaker">{language.t("context.inspect.empty")}</div>
            </div>
          }
        >
          <div class="flex flex-col gap-2">
            <div class="flex items-baseline justify-between gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.inspect.title")}</div>
              <div class="text-11-regular text-text-weaker">
                {formatter().number(inspect.data?.total)} · {inspect.data?.modelID}
                <Show when={inspectTime()}>{(t) => <> · {t()}</>}</Show>
              </div>
            </div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={inspectGroups()}>
                {(group) => (
                  <div
                    class="h-full"
                    style={{ width: `${group.percent}%`, "background-color": INSPECT_COLOR[group.key] }}
                  />
                )}
              </For>
            </div>
            <div class="grid grid-cols-1 @[32rem]:grid-cols-3 gap-4">
              <For each={inspectGroups()}>
                {(group) => (
                  <div class="flex flex-col gap-1">
                    <div class="flex items-center gap-1 text-11-regular text-text-weak">
                      <div class="size-2 rounded-sm" style={{ "background-color": INSPECT_COLOR[group.key] }} />
                      <div>{inspectLabel(group.key)}</div>
                      <div class="text-text-weaker">
                        {formatter().number(group.tokens)} · {group.percent.toLocaleString(language.intl())}%
                      </div>
                    </div>
                    <For each={group.items}>
                      {(item) => (
                        <div class="flex items-baseline justify-between gap-2 text-11-regular">
                          <div class="text-text-weaker truncate select-text" title={item.label}>
                            {item.label}
                          </div>
                          <div class="text-text-weak shrink-0">{formatter().number(item.tokens)}</div>
                        </div>
                      )}
                    </For>
                    <Show when={group.key === "tools" && group.count > group.items.length}>
                      <div class="text-11-regular text-text-weaker">
                        {language.t("context.inspect.more", { count: (group.count - group.items.length).toString() })}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <div class="text-11-regular text-text-weaker">{language.t("context.inspect.note")}</div>
          </div>
        </Show>

        {/* 260829 cc 估算只在**没有真实构成**时出现。此前两块无条件并列，而快照存在时
            估算是被完全支配的：快照把系统提示与工具定义拆到了每一条，估算却把同一坨
            囫囵报成「其他 99.5%」——同一份东西上面拆开了、下面又报一遍还报错了名字。
            快照是内存态、只留最后一轮，所以估算仍要留着兜底，只是让位。 */}
        <Show when={inspectGroups().length === 0 && breakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.breakdown.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={breakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": BREAKDOWN_COLOR[segment.key],
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={breakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                    <div>{breakdownLabel(segment.key)}</div>
                    <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
                  </div>
                )}
              </For>
            </div>
            <div class="text-11-regular text-text-weaker">{language.t("context.breakdown.note")}</div>
          </div>
        </Show>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.systemPrompt.title")}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2 select-text">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion multiple>
            <For each={messages()}>
              {(message) => (
                <RawMessage message={message} getParts={getParts} onRendered={restoreScroll} time={formatter().time} />
              )}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}
