import { expect, test } from "bun:test"
import {
  probeMcpChecks,
  probeModelCheck,
  selectProbeProviders,
  soulBudgetCheck,
  soulRegistryCheck,
  soulRenderCheck,
} from "@/cli/cmd/doctor"
import { MAX_SOUL_BYTES } from "@/soul/schema"

test("doctor warns about Soul registry issues", () => {
  expect(soulRegistryCheck(2, 1)).toEqual({
    name: "registry",
    status: "warn",
    detail: "2 valid Soul(s), 1 issue(s)",
  })
  expect(soulRegistryCheck(2, 0).status).toBe("ok")
})

test("doctor checks the independent Soul source budget", () => {
  expect(soulBudgetCheck("C:/souls/custom-id.md", MAX_SOUL_BYTES)).toMatchObject({
    name: "soul-source",
    status: "ok",
  })
  expect(soulBudgetCheck("C:/souls/custom-id.md", MAX_SOUL_BYTES + 1).status).toBe("warn")
  expect(soulRenderCheck(MAX_SOUL_BYTES + 1).status).toBe("ok")
  expect(soulRenderCheck(MAX_SOUL_BYTES + 1079).status).toBe("warn")
})

// 261109 Karina --probe 纯函数覆盖：排序/限次、模型结果映射、MCP 状态映射。

test("selectProbeProviders puts the default provider first and caps the count", () => {
  expect(selectProbeProviders(["a", "b", "c", "d"], { defaultProviderID: "c", max: 3 })).toEqual(["c", "a", "b"])
  // 默认 provider 不在候选里时不能越界，也不该凭空插进队首
  expect(selectProbeProviders(["a", "b", "c"], { defaultProviderID: "z", max: 3 })).toEqual(["a", "b", "c"])
  expect(selectProbeProviders(["a", "b", "c"], { max: 3 })).toEqual(["a", "b", "c"])
  // 限次：候选多于上限时截断，保证真实请求次数有确定上界
  expect(selectProbeProviders(["a", "b", "c", "d", "e"], { max: 3 })).toEqual(["a", "b", "c"])
})

test("probeModelCheck maps success and failure", () => {
  expect(probeModelCheck("test", { modelID: "test-model", ms: 1234 })).toEqual({
    name: "model:test",
    status: "ok",
    detail: "ok via test-model in 1234ms",
  })
  const failed = probeModelCheck("test", { error: new Error("401 unauthorized") })
  expect(failed.status).toBe("error")
  expect(failed.name).toBe("model:test")
  expect(failed.detail).toContain("401")
})

test("probeMcpChecks maps every terminal status and the empty config", () => {
  // 空配置：单条 skip，不影响退出码
  expect(probeMcpChecks({})).toEqual([{ name: "mcp", status: "skip", detail: "no servers configured" }])

  const checks = probeMcpChecks({
    ok: { status: "connected" },
    off: { status: "disabled" },
    auth: { status: "needs_auth" },
    reg: { status: "needs_client_registration", error: "client not registered" },
    dead: { status: "failed", error: "connection refused" },
    slow: { status: "connecting" },
  })
  expect(Object.fromEntries(checks.map((c) => [c.name, c]))).toMatchObject({
    "mcp:ok": { status: "ok", detail: "connected" },
    "mcp:off": { status: "skip", detail: "disabled in config" },
    "mcp:auth": { status: "warn", detail: "needs authentication" },
    "mcp:reg": { status: "warn", detail: "client not registered" },
    // failed 带 error 原文；等超时后仍停在 connecting 报 error（挂起比失败更难查）
    "mcp:dead": { status: "error", detail: "connection refused" },
    "mcp:slow": { status: "error", detail: "still connecting after probe deadline" },
  })
})
