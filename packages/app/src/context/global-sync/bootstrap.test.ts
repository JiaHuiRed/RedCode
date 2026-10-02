import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, Project } from "@redcode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@redcode-ai/ui/context"
import { bootstrapDirectory, loadAgentsQuery, loadPathQuery, loadUsageQuery } from "./bootstrap"
import type { State, VcsCache } from "./types"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

describe("bootstrapDirectory", () => {
  // 260901 cc 原名与断言是「status: loading → partial → complete」，但本仓历史上**从未**有过
  // 写这个字段的代码（git log -S setStore("status") 在 global-sync 下零命中），child-store 初始化
  // 直接给的就是 "complete"，bootstrap 里读它的那个 loading 变量也没人用（已一并删掉）。
  // 断言一个不存在的状态机没有意义，改成断言 bootstrap 真正做到的事：把后台那批慢请求跑完、
  // 把 agent 装进 store 并置 ready——那才是 submit gate 依赖的信号。
  test("populates agents and flips agent_ready after the slow bootstrap pass", async () => {
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

    await bootstrapDirectory({
      directory: "/project",
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: { list: async () => ({ data: [] }) },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        mcp: { status: async () => ({ data: {} }) },
        provider: {
          list: async () => ({ data: { all: [], connected: [], default: {} } }),
          // 260901 cc bootstrap 从 4c8b9e9d 起还会拉套餐额度（bootstrap.ts:197）。夹具漏了这个
          // mock，sdk.provider.quota 是 undefined → 整条 bootstrap 链抛错 → status 卡在 loading。
          quota: async () => ({ data: [] }),
        },
      } as unknown as OpencodeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.agent_ready).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.agent_ready).toBe(true)
    expect(store.agent.map((item) => item.name)).toEqual(["build"])
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
