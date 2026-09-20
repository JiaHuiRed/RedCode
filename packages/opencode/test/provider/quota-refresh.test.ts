import { expect, mock, test } from "bun:test"

const pending = new Map<string, Array<(response: Response) => void>>()
let calls = 0

void mock.module("@/util/proxy", () => ({
  fetchWithProxy: (_url: string, options: { headers?: HeadersInit }) => {
    const authorization = new Headers(options.headers).get("authorization") ?? ""
    calls += 1
    return new Promise<Response>((resolve) => {
      pending.set(authorization, [...(pending.get(authorization) ?? []), resolve])
    })
  },
}))

const ProviderQuota = await import("@/provider/quota")

function response(level: string, status = 200) {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        level,
        limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 12, nextResetTime: Date.now() + 1_800_000 }],
      },
    }),
    { status },
  )
}

async function waitForRequest(authorization: string) {
  for (let attempt = 0; attempt < 20 && !(pending.get(authorization)?.length); attempt++) {
    await Bun.sleep(0)
  }
  expect(pending.get(authorization)?.length).toBeGreaterThan(0)
}

function resolvePending(authorization: string, level: string, status = 200) {
  pending.get(authorization)?.shift()?.(response(level, status))
}

test("does not let an older credential refresh overwrite the latest snapshot", async () => {
  ProviderQuota.clear()
  pending.clear()
  calls = 0

  const oldRefresh = ProviderQuota.refreshCodingPlan("zhipuai-coding-plan", "old-key")
  await waitForRequest("old-key")
  const newRefresh = ProviderQuota.refreshCodingPlan("zhipuai-coding-plan", "new-key")
  await waitForRequest("new-key")

  resolvePending("new-key", "NEW")
  resolvePending("old-key", "OLD")
  await Promise.all([oldRefresh, newRefresh])

  expect(ProviderQuota.get("zhipuai-coding-plan")?.planType).toBe("NEW")
})

test("clears the previous snapshot when a new credential refresh fails", async () => {
  ProviderQuota.clear()
  pending.clear()
  calls = 0

  const oldRefresh = ProviderQuota.refreshCodingPlan("zhipuai-coding-plan", "old-key")
  await waitForRequest("old-key")
  resolvePending("old-key", "OLD")
  await oldRefresh
  expect(ProviderQuota.get("zhipuai-coding-plan")?.planType).toBe("OLD")

  const newRefresh = ProviderQuota.refreshCodingPlan("zhipuai-coding-plan", "new-key")
  await waitForRequest("new-key")
  resolvePending("new-key", "FAILED", 401)
  await newRefresh

  expect(ProviderQuota.get("zhipuai-coding-plan")).toBeUndefined()
})

test("shares a refresh already in flight for the same credential", async () => {
  ProviderQuota.clear()
  pending.clear()
  calls = 0

  const first = ProviderQuota.refreshCodingPlan("zhipuai-coding-plan", "same-key")
  await waitForRequest("same-key")
  const second = ProviderQuota.refreshCodingPlan("zhipuai-coding-plan", "same-key")
  resolvePending("same-key", "SAME")
  await Promise.all([first, second])

  expect(calls).toBe(1)
  expect(ProviderQuota.get("zhipuai-coding-plan")?.planType).toBe("SAME")
})

test("starts a new refresh when a credential is restored after switching away", async () => {
  ProviderQuota.clear()
  pending.clear()
  calls = 0

  const firstA = ProviderQuota.refreshCodingPlan("zhipuai-coding-plan", "a-key")
  await waitForRequest("a-key")
  const b = ProviderQuota.refreshCodingPlan("zhipuai-coding-plan", "b-key")
  await waitForRequest("b-key")
  const secondA = ProviderQuota.refreshCodingPlan("zhipuai-coding-plan", "a-key")
  await waitForRequest("a-key")

  resolvePending("b-key", "B")
  resolvePending("a-key", "A1")
  await waitForRequest("a-key")
  resolvePending("a-key", "A2")
  await Promise.all([firstA, b, secondA])

  expect(calls).toBe(3)
  expect(ProviderQuota.get("zhipuai-coding-plan")?.planType).toBe("A2")
})
