import { describe, expect, test } from "bun:test"
import * as ProviderQuota from "@/provider/quota"

describe("ProviderQuota.parseOpenCodeGo", () => {
  test("maps the three observed windows without guessing the length of a month", () => {
    const now = Date.parse("2026-11-04T03:00:00Z")
    const window = (percent: number, resetsAt: string) => ({ status: "ok", percent, resetsAt })
    const quota = ProviderQuota.parseOpenCodeGo({
      usage: {
        rolling: window(12, "2026-11-04T08:00:00Z"),
        weekly: window(34, "2026-11-09T00:00:00Z"),
        monthly: window(56, "2026-12-04T03:00:00Z"),
      },
    }, now)
    expect(quota?.primary).toEqual({ usedPercent: 12, windowMinutes: 300, resetAt: Date.parse("2026-11-04T08:00:00Z") / 1000, resetAfterSeconds: 18000 })
    expect(quota?.secondary?.usedPercent).toBe(34)
    expect(quota?.monthly?.usedPercent).toBe(56)
    expect(quota?.monthly?.windowMinutes).toBe(0)
  })

  test("omits unlimited or invalid windows and rejects a missing usage payload", () => {
    expect(ProviderQuota.parseOpenCodeGo({})).toBeUndefined()
    expect(ProviderQuota.parseOpenCodeGo({ usage: {
      rolling: { status: "ok", percent: 101, resetsAt: "2026-11-04T08:00:00Z" },
      weekly: { status: "ok", percent: 20, resetsAt: "bad" },
      monthly: { status: "unlimited", percent: 0, resetsAt: "2026-12-04T03:00:00Z" },
    } })).toBeUndefined()
  })

  test("keeps a rate-limited window visible", () => {
    const quota = ProviderQuota.parseOpenCodeGo({
      usage: { rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-11-04T08:00:00Z" } },
    })
    expect(quota?.primary?.usedPercent).toBe(100)
  })
})

describe("ProviderQuota.parseCodingPlan", () => {
  test("maps the five-hour and weekly token windows", () => {
    const now = Date.parse("2026-09-19T08:00:00Z")
    const result = ProviderQuota.parseCodingPlan(
      "zhipuai-coding-plan",
      {
        success: true,
        data: {
          level: "lite",
          limits: [
            { type: "TIME_LIMIT", percentage: 12, nextResetTime: now + 86_400_000 },
            { type: "CREDIT_LIMIT", unit: 6, percentage: 61, nextResetTime: now + 5_400_000 },
            { type: "CREDIT_LIMIT", unit: 3, percentage: 5, nextResetTime: now + 1_800_000 },
          ],
        },
      },
      now,
    )

    expect(result).toEqual({
      providerID: "zhipuai-coding-plan",
      capturedAt: now,
      planType: "LITE",
      primary: {
        usedPercent: 5,
        windowMinutes: 300,
        resetAfterSeconds: 1_800,
        resetAt: Math.floor((now + 1_800_000) / 1000),
      },
      secondary: {
        usedPercent: 61,
        windowMinutes: 10_080,
        resetAfterSeconds: 5_400,
        resetAt: Math.floor((now + 5_400_000) / 1000),
      },
    })
  })

  test("ignores a monitor response without token windows", () => {
    expect(
      ProviderQuota.parseCodingPlan("zhipuai-coding-plan", {
        success: true,
        data: { level: "lite", limits: [{ type: "TIME_LIMIT", percentage: 12 }] },
      }),
    ).toBeUndefined()
  })

  test("drops coding plan windows outside business ranges", () => {
    const now = Date.parse("2026-09-19T08:00:00Z")
    const result = ProviderQuota.parseCodingPlan(
      "zhipuai-coding-plan",
      {
        success: true,
        data: {
          level: "lite",
          limits: [
            { type: "CREDIT_LIMIT", unit: 3, percentage: -1, nextResetTime: now + 1_800_000 },
            { type: "CREDIT_LIMIT", unit: 6, percentage: 101, nextResetTime: now + 5_400_000 },
          ],
        },
      },
      now,
    )

    expect(result).toBeUndefined()
  })

  test("drops invalid response-header windows without dropping valid windows", () => {
    const result = ProviderQuota.parse(
      "openai",
      undefined,
      new Headers({
        "x-codex-plan-type": "plus",
        "x-codex-primary-used-percent": "101",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-after-seconds": "1800",
        "x-codex-primary-reset-at": "1758270600",
        "x-codex-secondary-used-percent": "20",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-after-seconds": "5400",
        "x-codex-secondary-reset-at": "1758274200",
      }),
    )

    expect(result?.primary).toBeUndefined()
    expect(result?.secondary?.usedPercent).toBe(20)
  })
})
