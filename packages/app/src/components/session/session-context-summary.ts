import { createMemo } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { Message, ProviderQuota } from "@redcode-ai/sdk/v2/client"
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

  return {
    messages,
    counts,
    metrics,
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
