import { describe, expect, test } from "bun:test"
import * as ProviderQuota from "@/provider/quota"

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
})
