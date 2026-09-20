import { Schema } from "effect"
import * as Log from "@redcode-ai/core/util/log"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { fetchWithProxy } from "@/util/proxy"
import type { ProviderID } from "./schema"

const log = Log.create({ service: "provider.quota" })

// 260831 cc 套餐额度快照。
//
// 来源：ChatGPT 订阅认证下，Codex 后端（chatgpt.com/backend-api/codex/responses）在
// **响应头**里回当前套餐的用量窗口。实测（哥哥的 Plus 账号）一次成功请求带回：
//
//   x-codex-plan-type: plus              x-codex-active-limit: premium
//   x-codex-primary-used-percent: 0      x-codex-primary-window-minutes: 300      ← 5 小时档
//   x-codex-primary-reset-after-seconds / -reset-at
//   x-codex-secondary-*                  window-minutes: 10080                    ← 7 天档
//   x-codex-credits-balance / -has-credits / -unlimited
//   x-base-model-inference-limit-name: gpt-reserve + 同构的 primary/secondary 组   ← 独立储备池
//
// 不是 SSE 流里的字段，所以取它**不需要碰响应体**——响应体是要交给 AI SDK 消费的流，
// clone/读取都会出事。
//
// 只读头、只存内存：额度是账号级的瞬时事实，重启即失效没有意义持久化。
// 存储刻意做成模块级而不是 InstanceState：写入点在插件的 fetch 回调里，那是 AI SDK 起的
// 裸 promise，没有 fiber 也没有 InstanceRef，InstanceState.get 会静默落到
// process.cwd() 键上（见 effect/instance-state.ts 的 fallbackContext）——写进去没人读得到，
// 而且不会报错。何况凭据本身就是进程级的（auth.json 只有一份）。

const Window = Schema.Struct({
  /** 0-100。厂商给的就是百分比，不是绝对量。 */
  usedPercent: Schema.Number,
  /** 窗口长度（分钟）。300 = 5 小时档，10080 = 7 天档。 */
  windowMinutes: Schema.Number,
  /** 距重置还有多少秒。 */
  resetAfterSeconds: Schema.Number,
  /** 重置时刻的 unix **秒**（不是毫秒，渲染前要 ×1000）。 */
  resetAt: Schema.Number,
})
export type Window = Schema.Schema.Type<typeof Window>

const Credits = Schema.Struct({
  balance: Schema.Number,
  has: Schema.Boolean,
  unlimited: Schema.Boolean,
})

export const Info = Schema.Struct({
  providerID: Schema.String,
  accountID: Schema.optional(Schema.String),
  /** Date.now()，毫秒。用来判快照有多旧。 */
  capturedAt: Schema.Number,
  /** x-codex-plan-type，如 "plus"。 */
  planType: Schema.String,
  /** x-codex-active-limit，如 "premium"。 */
  activeLimit: Schema.optional(Schema.String),
  primary: Schema.optional(Window),
  secondary: Schema.optional(Window),
  /** x-base-model-inference-limit-name，如 "gpt-reserve"。 */
  reserveName: Schema.optional(Schema.String),
  reserve: Schema.optional(Window),
  credits: Schema.optional(Credits),
}).annotate({ identifier: "ProviderQuota" })
export type Info = Schema.Schema.Type<typeof Info>

export const CODING_PLAN_PROVIDER_IDS = ["zhipuai-coding-plan", "zai-coding-plan"] as const

type CodingPlanObject = Record<string, unknown>

function object(value: unknown): CodingPlanObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as CodingPlanObject
}

function number(value: unknown): number | undefined {
  const result = typeof value === "number" ? value : Number(value)
  return Number.isFinite(result) ? result : undefined
}

function codingPlanWindow(
  limit: CodingPlanObject | undefined,
  unit: number,
  windowMinutes: number,
  now: number,
): Window | undefined {
  // 260920 Red Coding Plan 实测返回 CREDIT_LIMIT；保留 TOKENS_LIMIT 兼容旧版响应。
  if (limit?.type !== "CREDIT_LIMIT" && limit?.type !== "TOKENS_LIMIT") return undefined
  if (number(limit.unit) !== unit) return undefined
  const usedPercent = number(limit.percentage)
  const nextResetTime = number(limit.nextResetTime)
  if (usedPercent === undefined || nextResetTime === undefined) return undefined

  const resetAt = Math.floor(nextResetTime / 1000)
  if (resetAt <= 0) return undefined
  return {
    usedPercent,
    windowMinutes,
    resetAfterSeconds: Math.max(0, resetAt - Math.floor(now / 1000)),
    resetAt,
  }
}

/**
 * 将智谱 Coding Plan 监控接口映射到现有 quota 快照。现有共享快照只承载百分比、窗口和重置时间，
 * 因此先保留这些字段；接口返回的绝对积分字段暂不塞进 GPT 同构模型。
 */
export function parseCodingPlan(
  providerID: ProviderID | string,
  body: unknown,
  now = Date.now(),
): Info | undefined {
  const root = object(body)
  if (root?.success === false) return undefined
  const data = object(root?.data)
  if (!data || !Array.isArray(data.limits)) return undefined

  const limits = data.limits.map(object).filter((item): item is CodingPlanObject => item !== undefined)
  const primary = limits
    .map((limit) => codingPlanWindow(limit, 3, 300, now))
    .find((item): item is Window => item !== undefined)
  const secondary = limits
    .map((limit) => codingPlanWindow(limit, 6, 10080, now))
    .find((item): item is Window => item !== undefined)
  if (!primary && !secondary) return undefined

  const level = typeof data.level === "string" && data.level.length > 0 ? data.level.toUpperCase() : "GLM"
  return {
    providerID,
    capturedAt: now,
    planType: level,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  }
}

/**
 * 额度快照更新广播。走 GlobalBus（而不是 Bus.publish(ctx, …)）：额度是账号级事实，
 * 不带实例的 directory/project 章，GUI 才能在全项目范围看到。
 */
export const QuotaUpdated = BusEvent.define("provider.quota.updated", Info)

function num(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function bool(headers: Headers, name: string): boolean | undefined {
  const raw = headers.get(name)
  if (raw === null) return undefined
  // 厂商回的是 Python 风格的 "True"/"False"
  return raw.toLowerCase() === "true"
}

/**
 * 一组窗口头要四个字段齐全才算数——缺一个就说明这档不适用（例如 gpt-reserve 的
 * secondary 实测是 window-minutes: 0），半截数据渲染出来是误导。
 */
function window(headers: Headers, prefix: string): Window | undefined {
  const usedPercent = num(headers, `${prefix}used-percent`)
  const windowMinutes = num(headers, `${prefix}window-minutes`)
  const resetAfterSeconds = num(headers, `${prefix}reset-after-seconds`)
  const resetAt = num(headers, `${prefix}reset-at`)

  if (usedPercent === undefined || windowMinutes === undefined) return undefined
  if (resetAfterSeconds === undefined || resetAt === undefined) return undefined
  if (windowMinutes <= 0) return undefined

  return { usedPercent, windowMinutes, resetAfterSeconds, resetAt }
}

/**
 * 从响应头解析快照。`x-codex-plan-type` 缺失即判定「这不是订阅认证的响应」并返回
 * undefined —— API key 认证下这些头一个都不会有。
 */
export function parse(
  providerID: ProviderID | string,
  accountID: string | undefined,
  headers: Headers,
  now = Date.now(),
): Info | undefined {
  const planType = headers.get("x-codex-plan-type")
  if (!planType) return undefined

  const reserveName = headers.get("x-base-model-inference-limit-name") ?? undefined
  const creditsBalance = num(headers, "x-codex-credits-balance")

  return {
    providerID,
    ...(accountID ? { accountID } : {}),
    capturedAt: now,
    planType,
    ...(headers.get("x-codex-active-limit") ? { activeLimit: headers.get("x-codex-active-limit")! } : {}),
    ...(window(headers, "x-codex-primary-") ? { primary: window(headers, "x-codex-primary-")! } : {}),
    ...(window(headers, "x-codex-secondary-") ? { secondary: window(headers, "x-codex-secondary-")! } : {}),
    ...(reserveName ? { reserveName } : {}),
    ...(window(headers, "x-base-model-inference-primary-")
      ? { reserve: window(headers, "x-base-model-inference-primary-")! }
      : {}),
    ...(creditsBalance !== undefined
      ? {
          credits: {
            balance: creditsBalance,
            has: bool(headers, "x-codex-credits-has-credits") ?? false,
            unlimited: bool(headers, "x-codex-credits-unlimited") ?? false,
          },
        }
      : {}),
  }
}

const store = new Map<string, Info>()

function key(providerID: string, accountID: string | undefined) {
  return `${providerID}:${accountID ?? ""}`
}

/**
 * 按需查询 Coding Plan 监控接口。失败只丢弃本次刷新，不能影响模型请求或现有 GPT 额度。
 */
export async function refreshCodingPlan(providerID: (typeof CODING_PLAN_PROVIDER_IDS)[number], apiKey: string) {
  const baseURL = providerID === "zai-coding-plan" ? "https://api.z.ai" : "https://open.bigmodel.cn"

  try {
    const response = await fetchWithProxy(`${baseURL}/api/monitor/usage/quota/limit`, {
      headers: {
        authorization: apiKey,
        "accept-language": "zh-CN,zh",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      log.debug("coding plan quota request failed", { provider: providerID, status: response.status })
      return
    }

    const quota = parseCodingPlan(providerID, await response.json())
    if (!quota) return
    store.set(key(providerID, undefined), quota)
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: QuotaUpdated.type, properties: quota },
    })
    log.info("coding plan quota", {
      provider: providerID,
      plan: quota.planType,
      primary: quota.primary ? `${quota.primary.usedPercent}% / ${quota.primary.windowMinutes}min` : undefined,
      secondary: quota.secondary ? `${quota.secondary.usedPercent}% / ${quota.secondary.windowMinutes}min` : undefined,
    })
  } catch (error) {
    log.debug("coding plan quota refresh failed", { provider: providerID, error })
  }
}

/**
 * 供请求路径调用：解析并记下最新快照。**绝不向调用方抛错**——它挂在每一次模型请求上，
 * 解析失败不该把请求本身带走。
 */
export function record(providerID: ProviderID | string, accountID: string | undefined, headers: Headers): void {
  try {
    const quota = parse(providerID, accountID, headers)
    if (!quota) return
    store.set(key(providerID, accountID), quota)
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: QuotaUpdated.type, properties: quota },
    })
    log.info("plan quota", {
      provider: providerID,
      plan: quota.planType,
      primary: quota.primary ? `${quota.primary.usedPercent}% / ${quota.primary.windowMinutes}min` : undefined,
      secondary: quota.secondary ? `${quota.secondary.usedPercent}% / ${quota.secondary.windowMinutes}min` : undefined,
    })
  } catch (error) {
    log.warn("failed to record plan quota", { provider: providerID, error })
  }
}

export function get(providerID: ProviderID | string, accountID?: string): Info | undefined {
  return store.get(key(providerID, accountID))
}

export function list(): Info[] {
  return [...store.values()]
}

/** 仅供测试：模块级存储跨用例会串。 */
export function clear(): void {
  store.clear()
}
