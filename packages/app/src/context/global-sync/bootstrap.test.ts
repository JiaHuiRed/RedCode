import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, Project } from "@redcode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@redcode-ai/ui/context"
import { bootstrapDirectory } from "./bootstrap"
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
