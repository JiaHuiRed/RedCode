import { createMemo } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { Message, ProviderQuota } from "@redcode-ai/sdk/v2/client"
import type { IconProps } from "@redcode-ai/ui/icon"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { same } from "@/utils/same"
import { getSessionContextMetrics } from "./session-context-metrics"
import { createSessionContextFormatter } from "./session-context-format"

// 260921 Red 从 session-context-tab.tsx 迁出。右侧审查栏的常态态是「贴边矮胶囊」，
// 要显示四段摘要（上下文 / 套餐额度 / 真实构成 / 原始消息），而同一批摘要字符串
// 上下文 tab 的折叠分组也在用——两边各写一份必然漂移，摘要是共享概念，收单个 owner。
// quota 辅助函数被摘要与 tab 的展开态同时消费，随迁。

export type QuotaWindowData = NonNullable<ProviderQuota["primary"]>
// 260831 Red hey-api 把数字字段生成为 number | "NaN" | "Infinity" | "-Infinity" 的 union，
//   归一化成 number 才能做百分比/时长/时间运算
export type QuotaNumeric = number | "NaN" | "Infinity" | "-Infinity"

export const quotaNum = (v: QuotaNumeric) => (typeof v === "number" ? v : 0)

// 260902 cc 百分比显示保护。实测（plus 账号连发四次请求）x-codex-*-used-percent 回的一直是
// 整数 3 / 4，codex 侧同源的那条 JSON 路在 OpenAPI 里也直接声明成 i32，说明服务端自己就
// round 过。但整条链路（响应头 → Number() → Schema.Number → openapi 的 number）没有任何
// 一处取整，服务端哪天不 round 了，面板会原样渲染出 33.333333333333336%。
// 跟 session-context-format.ts 的 percent() 一个路数：toLocaleString 而不是 toFixed，
// 整数不会被补成 "3.0"。
export const quotaPercent = (percent: number, locale: string) =>
  percent.toLocaleString(locale, { maximumFractionDigits: 1 })

// 260831 Red 额度进度条颜色分档：接近用完才告急，不然整页都是红色
export const quotaColor = (percent: number) =>
  percent >= 90 ? "var(--syntax-critical)" : percent >= 60 ? "var(--syntax-warning)" : "var(--syntax-info)"

export const quotaDuration = (minutes: number) =>
  minutes >= 1440 && minutes % 1440 === 0
    ? `${minutes / 1440}d`
    : minutes % 60 === 0
      ? `${minutes / 60}h`
      : `${minutes}m`

const quotaCompactSummary = (quota: ProviderQuota, locale: string) => {
  const windows = [quota.primary, quota.secondary].filter((window): window is QuotaWindowData => !!window)
  return [
    quota.planType,
    ...windows.map(
      (window) =>
        `${quotaDuration(quotaNum(window.windowMinutes))} ${quotaPercent(quotaNum(window.usedPercent), locale)}%`,
    ),
  ].join(" · ")
}

const emptyMessages: Message[] = []

/**
 * 右侧审查栏共用的一组会话上下文数据与四段摘要。
 *
 * 消费方：
 * - `SessionSidePanel` 折叠态矮胶囊：只读 context/quota/inspect/rawMessages 四个摘要
 * - `SessionContextTab` 展开态：摘要 + messages/counts/metrics/formatter/inspectData 明细
 *
 * inspect 查询带 placeholderData：solid-query 的 useQuery 内部是 createResource，
 * key 一变（每轮请求都变）就成「无缓存 pending」，直接读 .data 会向最近的 Suspense 抛。
 * 折叠胶囊在 app 级 Suspense 之内、面板自己的 Suspense 之外，少了这一行，
 * 每次工具调用都会把整棵树换成满屏 Splash（见 session-context-tab.tsx 同款注释）。
 */
export function useSessionContextSummaries() {
  const sync = useSync()
  const language = useLanguage()
  const globalSync = useServerSync()
  const providers = useProviders()
  const sdk = useSDK()
  const { params } = useSessionLayout()

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync.data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const metrics = createMemo(() => getSessionContextMetrics(messages(), [...providers.all().values()]))
  const ctx = createMemo(() => metrics().context)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return { all: all.length, user, assistant }
  })

  // 260820 cc 真实构成：服务端在「请求真正发出去的那一刻」记下的快照
  // （session/context-snapshot.ts）。与估算的区别不是精度，是**范围**——
  // system 提示与 tool schema 这两块从来没到过客户端，估算器手里根本没有这两份数据，
  // 而它们恰恰是前缀里最大且最不透明的部分。快照只在服务端留最后一轮，
  // 会话还没在本进程发过请求时是 404，那不是错误，按「暂无」显示。
  const inspect = useQuery(() => ({
    queryKey: ["session", params.id ?? "", ctx()?.message.id ?? "", ctx()?.window ?? 0, "context-inspect"] as const,
    enabled: () => !!params.id,
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

  // 260706 Red 子代理(Task/Agent 工具)创建的子 session 的 LLM 调用成本在 DeepSeek 平台真实计费，
  // 但原 metrics 只统计父 session 自身消息——面板显示"总成本"严重偏低。
  // 通过 SSE 全局事件流同步到 store 的子 session 消息汇总其 cost 一并显示。
  // 260922 Red 从 session-context-tab.tsx 迁来：折叠胶囊也要显示总成本，两处各算一份必然漂移。
  const childCost = createMemo(() => {
    const id = params.id
    if (!id) return 0
    let total = 0
    for (const s of sync.data.session) {
      if (s.parentID !== id) continue
      const msgs = sync.data.message[s.id]
      if (!msgs) continue
      for (const message of msgs) {
        if (message.role === "assistant") total += message.cost
      }
    }
    return total
  })

  const cost = createMemo(() => {
    const m = metrics()
    return formatter().cost(m.totalCost + childCost(), m.costCurrency)
  })

  return {
    messages,
    counts,
    metrics,
    cost,
    ctx,
    formatter,
    inspectData: () => inspect.data,
    /** 「上下文」段摘要：消息数 · 累计 token · 单次命中率 */
    context: () =>
      [
        `${counts().all.toLocaleString(language.intl())} ${language.t("context.stats.messages")}`,
        formatter().number(ctx()?.total),
        ctx()?.cacheHit != null
          ? `${language.t("context.stats.turnCacheHit")} ${formatter().percent(ctx()!.cacheHit!)}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    /** 「套餐额度」段摘要：planType · 窗口 已用%；无额度数据时返回空串，由调用方定空态 */
    quota: () => globalSync.data.provider_quota.map((quota) => quotaCompactSummary(quota, language.intl())).join(" / "),
    /** 「真实构成」段摘要：快照总量 · modelID；无快照时返回空态文案 */
    inspect: () => {
      const total = inspect.data?.total
      if (!total) return language.t("context.inspect.empty")
      return [formatter().number(total), inspect.data?.modelID].filter(Boolean).join(" · ")
    },
    /** 「原始消息」段摘要：消息数 */
    rawMessages: () => messages().length.toLocaleString(language.intl()),
  }
}

/** 折叠矮胶囊里一段分组的明细行。value 已格式化；color 走 --syntax-* token，不给就用默认色。 */
export type CapsuleSummaryDetail = { label: string; value: string; color?: string }

/** 折叠矮胶囊的一段分组：收起只有一行关键数字，点开才铺明细。 */
export type CapsuleSummaryGroup = {
  id: "context" | "quota" | "inspect" | "rawMessages"
  icon: IconProps["name"]
  label: string
  value: string
  valueColor?: string
  /** 收起态也要一眼看出占比的堆叠条（目前只有「真实构成」用）。 */
  bar?: InspectSegment[]
  /** 折叠态默认铺开明细（「上下文」用：那几个读数比组名本身重要）。 */
  defaultExpanded?: boolean
  details: CapsuleSummaryDetail[]
}

// 260922 Red 收起态显示哪个数字由「用得最狠的那个窗口」决定：胶囊收窄到 ~280px 后，
// 「planType · 5h 62% · 7d 31%」会被截成半截，只有单个百分比活得下来。
const quotaPeakPercent = (quotas: ProviderQuota[]) =>
  Math.max(
    0,
    ...quotas.flatMap((quota) =>
      [quota.primary, quota.secondary, quota.reserve]
        .filter((window): window is QuotaWindowData => !!window)
        .map((window) => quotaNum(window.usedPercent)),
    ),
  )

/**
 * 260922 Red 折叠矮胶囊的四段分组明细，形态对齐 Codex 侧栏：收起一行只留关键数字，
 * 点开才铺明细。与四段摘要同一个 owner（useSessionContextSummaries），侧栏只负责渲染
 * ——两边各算一份明细必然漂移。
 *
 * 收起态的 value 刻意只取**一个**字段，其余全部下放到 details：胶囊竖长横窄之后，
 * 「102 消息数 · 13.4M · 单次命中率 96.7%」这种串在这一行里只剩半截，满值没意义。
 */
export function useCapsuleSummaryGroups() {
  const language = useLanguage()
  const globalSync = useServerSync()
  const summaries = useSessionContextSummaries()
  const formatter = summaries.formatter
  const counts = summaries.counts
  const ctx = summaries.ctx
  const locale = () => language.intl()

  // 260922 Red 收起态的「上下文」默认铺开（哥哥圈定的这五项才是最关键的读数），
  // 顺序按重要性排：量 → 用量 → 缓存 → 命中质量 → 成本。
  const contextDetails = createMemo<CapsuleSummaryDetail[]>(() => {
    const current = ctx()
    const f = formatter()
    const cacheRead = current?.cacheRead ?? 0
    const cacheWrite = current?.cacheWrite ?? 0
    const cacheHit = current?.cacheHit != null ? ` (${f.percent(current.cacheHit)})` : ""
    const turnHit = current?.turnHitPct
    return [
      { label: language.t("context.stats.messages"), value: counts().all.toLocaleString(locale()) },
      { label: language.t("context.stats.totalTokens"), value: f.number(current?.total) },
      {
        label: language.t("context.stats.cacheTokens"),
        value:
          cacheRead <= 0 && cacheWrite <= 0
            ? "—"
             : cacheWrite
               ? `${f.compact(cacheRead)} / ${f.compact(cacheWrite)}${cacheHit}`
               : `${f.compact(cacheRead)}${cacheHit}`,
        color: "var(--syntax-info)",
      },
      {
        label: language.t("context.stats.turnCacheHit"),
        value: turnHit == null ? "—" : current?.stalled ? `${f.percent(turnHit)} · 缓存未延伸` : f.percent(turnHit),
        color: "var(--syntax-critical)",
      },
      { label: language.t("context.stats.totalCost"), value: summaries.cost(), color: "var(--syntax-critical)" },
    ]
  })

  const quotaDetails = createMemo<CapsuleSummaryDetail[]>(() =>
    globalSync.data.provider_quota.flatMap((quota) =>
      [
        { label: language.t("context.quota.window.primary"), window: quota.primary },
        { label: language.t("context.quota.window.secondary"), window: quota.secondary },
        {
          label: quota.reserveName
            ? `${language.t("context.quota.window.reserve")} · ${quota.reserveName}`
            : language.t("context.quota.window.reserve"),
          window: quota.reserve,
        },
      ]
        .filter((entry): entry is { label: string; window: QuotaWindowData } => !!entry.window)
        .map((entry) => {
          const percent = quotaNum(entry.window.usedPercent)
          return {
            label: entry.label,
            value: `${quotaPercent(percent, locale())}% · ${quotaDuration(quotaNum(entry.window.windowMinutes))}`,
            color: quotaColor(percent),
          }
        }),
    ),
  )

  const inspectDetails = createMemo<CapsuleSummaryDetail[]>(() => {
    const snapshot = summaries.inspectData()
    if (!snapshot || snapshot.total <= 0) return []
    const f = formatter()
    return [
      { label: language.t("context.inspect.system"), tokens: snapshot.system.tokens },
      { label: language.t("context.inspect.tools"), tokens: snapshot.tools.tokens },
      { label: language.t("context.inspect.messages"), tokens: snapshot.messages.tokens },
    ]
      .filter((entry) => entry.tokens > 0)
      .map((entry) => ({
        label: entry.label,
        value: `${f.number(entry.tokens)} · ${Math.round((entry.tokens / snapshot.total) * 100)}%`,
      }))
  })

  const rawMessageDetails = createMemo<CapsuleSummaryDetail[]>(() => {
    const stats = counts()
    return [
      { label: language.t("context.breakdown.user"), value: stats.user.toLocaleString(locale()) },
      { label: language.t("context.breakdown.assistant"), value: stats.assistant.toLocaleString(locale()) },
    ]
  })

  return (): CapsuleSummaryGroup[] => {
    const quotas = globalSync.data.provider_quota
    const quotaPeak = quotaPeakPercent(quotas)
    const snapshot = summaries.inspectData()
    return [
      {
        id: "context",
        icon: "brain",
        label: language.t("context.summary.title"),
        value: formatter().number(ctx()?.total),
        defaultExpanded: true,
        details: contextDetails(),
      },
      {
        id: "quota",
        icon: "volume",
        label: language.t("context.quota.title"),
        value: quotas.length ? `${quotaPercent(quotaPeak, locale())}%` : "—",
        valueColor: quotas.length ? quotaColor(quotaPeak) : undefined,
        details: quotaDetails(),
      },
      {
        id: "inspect",
        icon: "bullet-list",
        label: language.t("context.inspect.title"),
        value: snapshot && snapshot.total > 0 ? formatter().number(snapshot.total) : "—",
        bar: inspectBarSegments(snapshot),
        details: inspectDetails(),
      },
      {
        id: "rawMessages",
        icon: "code-lines",
        label: language.t("context.rawMessages.title"),
        value: summaries.rawMessages(),
        details: rawMessageDetails(),
      },
    ]
  }
}

// 260820 cc 真实构成三块的配色。与上下文 tab 里估算版（BREAKDOWN_COLOR.system）刻意同色
// （都是 info）——两块讲的是同一件事的估算版与实测版，颜色一致才看得出对应关系。
// 260922 Red 从 session-context-tab.tsx 迁来：折叠态的比例条要给同一套色，
// 两处各留一份定义必然漂移。
export const INSPECT_COLOR = {
  system: "var(--syntax-info)",
  tools: "var(--syntax-warning)",
  messages: "var(--syntax-property)",
} as const

export type InspectKey = keyof typeof INSPECT_COLOR

/** 真实构成的一段占比。percent 不取整，精度由渲染方决定。 */
export type InspectSegment = { key: InspectKey; percent: number; color: string }

/**
 * 260922 Red 真实构成的比例条。折叠态只剩一个总数时看不出构成，
 * 把 system/tools/messages 三块的占比抽出来给两个折叠面（右栏胶囊的行、上下文 tab 的
 * CollapsibleSection）共用——比例算法只此一份。
 */
export function inspectBarSegments(
  snapshot:
    | { total: number; system: { tokens: number }; tools: { tokens: number }; messages: { tokens: number } }
    | null
    | undefined,
): InspectSegment[] {
  if (!snapshot || snapshot.total <= 0) return []
  return (["system", "tools", "messages"] as const)
    .map((key) => ({ key, tokens: snapshot[key].tokens }))
    .filter((entry) => entry.tokens > 0)
    .map((entry) => ({
      key: entry.key,
      percent: (entry.tokens / snapshot.total) * 100,
      color: INSPECT_COLOR[entry.key],
    }))
}