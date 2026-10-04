import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, Project } from "@redcode-ai/sdk/v2/client"
import { createOpencodeClient } from "@redcode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@redcode-ai/ui/context"
import { bootstrapDirectory, loadAgentsQuery, loadPathQuery, loadUsageQuery } from "./bootstrap"
import { createRefreshQueue } from "./queue"
import type { State, VcsCache } from "./types"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

// 261004 Red 使用真实 SDK 与隔离 transport，回归覆盖实际加载完成信号和刷新队列的并发上限。
function bootstrapInput(directory = "/project", handle = async (_request: Request) => {}) {
  const [store, setStore] = createStore<State>({
    status: "loading",
    agent: [],
    agent_ready: false,
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    message_trimmed: {},
    todo: {},
    goal: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 64,
    message: {},
    part: {},
    part_text_accum_delta: {},
  })

  const responses: Record<string, unknown> = {
    "/agent": [{ name: "build", mode: "primary" }],
    "/config": {},
    "/config/providers": { providers: [], default: {} },
    "/session/status": {},
    "/vcs": null,
    "/command": [],
    "/permission": [],
    "/question": [],
  }
  return {
    directory,
    global: {
      config: {} satisfies Config,
      path: { state: "", config: "", worktree: directory, directory, home: "/home" },
      project: [{ id: "project", worktree: directory } as Project],
      provider,
    },
    sdk: createOpencodeClient({
      baseUrl: "http://bootstrap.test",
      directory,
      throwOnError: true,
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        const request = input instanceof Request ? input : new Request(input)
        const route = new URL(request.url).pathname
        if (!(route in responses)) throw new Error(`Unexpected bootstrap request: ${route}`)
        await handle(request)
        return Response.json(responses[route])
      }, globalThis.fetch),
    }),
    store,
    setStore,
    vcsCache: { setStore() {} } as unknown as VcsCache,
    loadSessions() {},
    translate: (key: string) => key,
    queryClient: new QueryClient(),
  } satisfies Parameters<typeof bootstrapDirectory>[0]
}

describe("bootstrapDirectory", () => {
  test("populates agents and flips agent_ready before resolving", async () => {
    const input = bootstrapInput()
    try {
      await bootstrapDirectory(input)
      expect(input.store.agent_ready).toBe(true)
      expect(input.store.agent.map((item) => item.name)).toEqual(["build"])
    } finally {
      input.queryClient.clear()
    }
  })

  test("stays pending until the real slow requests finish", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const input = bootstrapInput("/project", async (request) => {
      if (new URL(request.url).pathname !== "/config") return
      started.resolve()
      await release.promise
    })
    let settled = false
    const pending = bootstrapDirectory(input).then(() => {
      settled = true
    })
    try {
      await started.promise
      expect(settled).toBe(false)
    } finally {
      release.resolve()
      await pending
      input.queryClient.clear()
    }
    expect(settled).toBe(true)
  })

  test("keeps the third directory queued while two real bootstraps are loading", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const directories: string[] = []
    const inputs = ["/A", "/B", "/C"].map((directory) =>
      bootstrapInput(directory, async (request) => {
        if (new URL(request.url).pathname !== "/config") return
        directories.push(directory)
        if (directories.length === 2) started.resolve()
        await release.promise
      }),
    )
    let completed = 0
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: async (directory) => {
        await bootstrapDirectory(inputs.find((input) => input.directory === directory)!)
        completed += 1
        if (completed === inputs.length) finished.resolve()
      },
    })
    inputs.forEach((input) => queue.push(input.directory))
    try {
      await started.promise
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(directories).toEqual(["/A", "/B"])
      expect(completed).toBe(0)
    } finally {
      release.resolve()
      await finished.promise
      queue.dispose()
      inputs.forEach((input) => input.queryClient.clear())
    }
    expect(directories).toEqual(["/A", "/B", "/C"])
  })
})

describe("loadAgentsQuery", () => {
  // 261002 Red 设置→智能体页曾因全局 refetchOnMount:false + 本查询无自愈路径，首次请求失败后
  // 整页永久空白。下面两个字段就是自愈路径本身，误删会无声复发，钉在断言里防漂移。
  test("opts out of the global no-refetch defaults with a 30s stale window", () => {
    const options = loadAgentsQuery(null, {} as OpencodeClient)
    expect(options.refetchOnMount).toBe(true)
    expect(options.staleTime).toBe(30_000)
    // queryKey 是带 dataTag 的品牌数组，toEqual 的重载不认，走序列化比较。
    expect(JSON.stringify(options.queryKey)).toBe(JSON.stringify([null, "agents"]))
  })
})

describe("self-healing query options", () => {
  // 261002 Red A1 审计：全局 QueryProvider 三处 refetch 全关后，凡是「无失效通道 + 门控/
  //   低频挂载」的查询，首载失败就永久冻结、首载成功也永远吃旧快照（usage 看板数字不更新、
  //   path/mcp/lsp 失败后重进目录无触发点）。本批给 usage/path 补了局部 refetchOnMount +
  //   staleTime（mcp/lsp 在 server-sync.tsx，同构改动）。字段是自愈路径本身，误删无声复发。
  test("loadUsageQuery refetches on mount within its 60s stale window", () => {
    const options = loadUsageQuery("/project", "all", {} as OpencodeClient)
    expect(options.refetchOnMount).toBe(true)
    expect(options.staleTime).toBe(60_000)
    expect(JSON.stringify(options.queryKey)).toBe(JSON.stringify(["/project", "usage", "all"]))
  })

  test("loadPathQuery opts out of the global no-refetch defaults", () => {
    const options = loadPathQuery("/project", {} as OpencodeClient)
    expect(options.refetchOnMount).toBe(true)
    expect(options.staleTime).toBe(60_000)
    expect(JSON.stringify(options.queryKey)).toBe(JSON.stringify(["/project", "path"]))
  })
})
