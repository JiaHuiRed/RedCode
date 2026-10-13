import type { Page, Route } from "@playwright/test"
import type { SessionContextInspectResponse, SessionUsageResponse } from "@redcode-ai/sdk/v2/client"

const emptyList = new Set([
  "/skill",
  "/command",
  "/lsp",
  "/formatter",
  "/permission",
  "/question",
  "/vcs/status",
  "/vcs/diff",
  // 261013 Red soul 列表未 mock 时会吃到下方兜底的 {}，组件里 soulList.data?.find
  // 对对象取 find 直接 TypeError 崩掉整个 session 页（CI e2e 261008 Soul V1A 起稳定红）。
  "/soul",
])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"])

export interface MockServerConfig {
  provider: unknown
  directory: string
  project: unknown
  sessions: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (sessionId: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
}

export async function mockRedCodeServer(page: Page, config: MockServerConfig) {
  const staticRoutes: Record<string, unknown> = {
    "/provider": config.provider,
    "/path": {
      state: config.directory,
      config: config.directory,
      worktree: config.directory,
      directory: config.directory,
      home: "C:/RedCode",
    },
    "/project": [config.project],
    "/project/current": config.project,
    "/agent": [{ name: "build", mode: "primary" }],
    "/vcs": { branch: "main", default_branch: "main" },
    "/session": config.sessions,
    "/session/usage": {
      range: "all",
      sessions: 0,
      messages: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      daily: [],
      models: [],
      dailyByModel: [],
    } satisfies SessionUsageResponse,
  }

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    if (url.port !== targetPort) return route.fallback()

    const path = url.pathname
    if (path === "/global/event" || path === "/event") return sse(route)
    if (emptyObject.has(path)) return json(route, {})
    if (emptyList.has(path)) return json(route, [])
    if (path in staticRoutes) return json(route, staticRoutes[path])

    const sessionMatch = path.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      const session = config.sessions.find((s) => s.id === sessionMatch[1])
      return json(route, session ?? {})
    }

    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(path)) return json(route, [])

    // 261013 Red changes 页有严格形状校验（validatePage：latest/cursor 必须为安全整数），
    // 兜底的 {} 会触发 "invalid session changes page" console.error 挂掉冒烟断言。
    if (/^\/session\/[^/]+\/changes$/.test(path)) {
      return json(route, { latest: -1, cursor: -1, oldest: null, changes: [] })
    }

    if (/^\/session\/[^/]+\/context-inspect$/.test(path)) {
      return json(route, {
        providerID: "",
        modelID: "",
        time: 0,
        total: 0,
        system: { tokens: 0, confidence: "low", segments: [] },
        tools: { count: 0, tokens: 0, confidence: "low", top: [] },
        messages: { count: 0, tokens: 0, confidence: "low", byRole: [] },
      } satisfies SessionContextInspectResponse)
    }

    const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const before = url.searchParams.get("before") ?? undefined
      const pageData = config.pageMessages(messagesMatch[1], limit, before)
      return json(route, pageData.items, pageData.cursor ? { "x-next-cursor": pageData.cursor } : undefined)
    }

    return json(route, {})
  })
}

function json(route: Route, body: unknown, headers?: Record<string, string>) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}
