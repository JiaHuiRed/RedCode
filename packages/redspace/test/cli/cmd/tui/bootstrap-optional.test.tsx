/** @jsxImportSource @opentui/solid */
/**
 * TUI bootstrap second stage must be fail-soft. The phase-2 Promise.all used to
 * be `void`-ed without its own catch and without being returned to the outer
 * chain, so a single rejecting optional request left store.status stuck at
 * "partial" forever (the outer bootstrap .catch cannot see a fire-and-forget
 * promise). Reachable rejection vectors: a 200 response whose body fails
 * JSON.parse (client.gen.ts parses inside the async request fn, so the method
 * rejects), listSessions shape mismatches, and any explicit throwOnError.
 * Plain HTTP 500s and network errors do NOT reject — the generated client
 * swallows them into { data: undefined } — so the second test pins that.
 */
import { describe, expect, test } from "bun:test"
import * as Log from "@redcode-ai/core/util/log"
import { Global } from "@redcode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@redcode-ai/sdk/v2"

// 200 with a JSON content-type but an unparseable body: the SDK client rejects
// instead of resolving with { data: undefined }.
const broken = () => new Response("not json", { headers: { "content-type": "application/json" } })

const sessionPayload = {
  id: "ses_optional",
  title: "optional",
  time: { created: 0, updated: 0 },
  version: "1.14.42",
  directory,
  project_id: "proj_test",
}

describe("tui bootstrap optional phase", () => {
  test("rejecting optional endpoints still reach complete and keep defaults", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    // mount() itself waits for status === "complete", so resolving at all is
    // the assertion that the phase did not get stuck on "partial".
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/session") return json([sessionPayload])
      if (url.pathname === "/lsp") return broken()
      if (url.pathname === "/provider/quota") return broken()
      if (url.pathname === "/vcs") return broken()
      return undefined
    })

    try {
      expect(sync.status).toBe("complete")
      // the request that succeeded still lands in the store
      expect(sync.data.session.map((s) => s.id)).toEqual(["ses_optional"])
      // failed requests keep their defaults instead of blocking complete
      expect(sync.data.lsp).toEqual([])
      expect(sync.data.provider_quota).toEqual([])
      expect(sync.data.vcs).toBeUndefined()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("HTTP 500 on optional endpoints is client-soft and still completes", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const { app, sync } = await mount((url) => {
      if (url.pathname === "/lsp") return json([], { status: 500 })
      if (url.pathname === "/provider/quota") return json([], { status: 500 })
      if (url.pathname === "/vcs") return json([], { status: 500 })
      return undefined
    })

    try {
      expect(sync.status).toBe("complete")
      expect(sync.data.lsp).toEqual([])
      expect(sync.data.provider_quota).toEqual([])
      expect(sync.data.vcs).toBeUndefined()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  // 261114 Red 恢复门禁竞态：快照在途时 session.status idle 事件先到。服务端快照只含
  // 非 idle 会话（idle 从状态表删除），裸 reconcile 会把拉取期间已变 idle 的会话按旧
  // 快照复活成 busy；门禁按 sessionID 合并、实时优先。
  test("late session.status snapshot does not resurrect sessions gone idle during fetch", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let emitFn: ((event: GlobalEvent) => void) | undefined
    const idleDuringFetch: GlobalEvent = {
      directory,
      project: "proj_test",
      payload: {
        id: "evt_race",
        type: "session.status",
        properties: { sessionID: "ses_race", status: { type: "idle" } },
      },
    }
    const { app, sync } = await mount(
      (url) => {
        if (url.pathname === "/permission" || url.pathname === "/question") return json([])
        if (url.pathname === "/session/status") {
          // 快照挂起 50ms；10ms 时先投递 idle 事件（SDK 事件队列批量冲洗后
          // ~26ms 落到 recovery.changed + store），快照 ~50ms 才带旧 busy 到达。
          setTimeout(() => emitFn?.(idleDuringFetch), 10)
          // 261113 Red complete 不再等恢复请求（悬挂不阻塞），快照落地时机改由
          // 第二个会话 ses_snapshot 的出现来观测——它只可能来自这份快照。
          return Bun.sleep(50).then(() => json({ ses_race: { type: "busy" }, ses_snapshot: { type: "busy" } }))
        }
        return undefined
      },
      { afterReady: ({ emit }) => (emitFn = emit) },
    )

    try {
      expect(sync.status).toBe("complete")
      await wait(() => sync.data.session_status["ses_snapshot"] !== undefined)
      expect(sync.data.session_status["ses_race"]).toEqual({ type: "idle" })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})

// 261113 Red bootstrap 悬挂回归。修复前：第一阶段把 console.state 一起 await，一次悬挂
// 就把首屏/partial 卡死；第二阶段用一个 allSettled 统住 complete，任一可选请求悬挂就永远
// 停在 partial（--session --fork 永不触发）。修复后各请求各自落地，complete 只等
// session 列表；迟到的结果按 bootstrap generation 丢弃旧一轮。
describe("tui bootstrap hanging requests", () => {
  test("hanging console.state does not block first screen or complete and still lands", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let resolveConsole: ((value: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => (resolveConsole = resolve))
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/experimental/console") return pending
      if (url.pathname === "/permission" || url.pathname === "/question") return json([])
      return undefined
    })

    try {
      // mount() 默认等到 complete：修复前这里会超时（console.state 挂着，status 停在 loading）
      expect(sync.status).toBe("complete")
      expect(sync.data.console_state.consoleManagedProviders).toEqual([])
      resolveConsole!(json({ consoleManagedProviders: ["anthropic"], switchableOrgCount: 2 }))
      await wait(() => sync.data.console_state.consoleManagedProviders.length === 1)
      expect(sync.data.console_state.switchableOrgCount).toBe(2)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("hanging mcp.status does not block complete and applies when it lands", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let resolveMcp: ((value: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => (resolveMcp = resolve))
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/mcp") return pending
      if (url.pathname === "/permission" || url.pathname === "/question") return json([])
      return undefined
    })

    try {
      // 修复前：可选阶段 allSettled 等这个请求，complete 永不触发（mount 超时）
      expect(sync.status).toBe("complete")
      expect(sync.data.mcp).toEqual({})
      resolveMcp!(json({ slow: { status: "connected" } }))
      await wait(() => sync.data.mcp.slow?.status === "connected")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("hanging permission.list is still fetched and merges live events", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let resolvePermission: ((value: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => (resolvePermission = resolve))
    const { app, sync, emit } = await mount((url) => {
      if (url.pathname === "/permission") return pending
      if (url.pathname === "/question") return json([])
      return undefined
    })

    try {
      expect(sync.status).toBe("complete")
      const asked: GlobalEvent = {
        directory,
        project: "proj_test",
        payload: {
          id: "evt_permission_asked",
          type: "permission.asked",
          properties: {
            id: "per_1",
            sessionID: "ses_perm",
            permission: "edit",
            patterns: ["*"],
            metadata: {},
            always: [],
          },
        },
      }
      emit(asked)
      await wait(() => sync.data.permission["ses_perm"]?.length === 1)
      // 快照在 ask 之后才回来且不含这条（服务端取快照时它还没出现）：恢复不能被跳过，
      // 也不能把悬挂期间收到的权限请求按旧快照抹掉。
      resolvePermission!(json([]))
      await Bun.sleep(30)
      expect(sync.data.permission["ses_perm"]?.map((request) => request.id)).toEqual(["per_1"])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("complete waits for session.list so a forked session is not overwritten", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let resolveSession: ((value: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => (resolveSession = resolve))
    const { app, sync } = await mount(
      (url) => {
        if (url.pathname === "/session") return pending
        if (url.pathname === "/permission" || url.pathname === "/question") return json([])
        return undefined
      },
      undefined,
      { waitFor: "partial" },
    )

    try {
      // --session --fork 在 complete 时 fork，列表还没落地就 fork 会被迟到的列表覆盖。
      expect(sync.status).toBe("partial")
      await Bun.sleep(30)
      expect(sync.status).toBe("partial")
      expect(sync.data.session).toEqual([])
      resolveSession!(json([sessionPayload]))
      await wait(() => sync.status === "complete")
      expect(sync.data.session.map((session) => session.id)).toEqual(["ses_optional"])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("a stale bootstrap cannot overwrite the newer generation's results", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const gates: Array<(value: Response) => void> = []
    const { app, sync, emit } = await mount((url) => {
      if (url.pathname === "/experimental/console")
        return new Promise<Response>((resolve) => gates.push(resolve))
      if (url.pathname === "/permission" || url.pathname === "/question") return json([])
      return undefined
    })

    try {
      expect(gates).toHaveLength(1)
      // instance.disposed 会让 Sync 重新 bootstrap 一轮；两轮各持一个 console.state 响应。
      emit({
        directory,
        project: "proj_test",
        payload: { id: "evt_disposed", type: "server.instance.disposed", properties: { directory } },
      } satisfies GlobalEvent)
      await wait(() => gates.length === 2)

      gates[1]!(json({ consoleManagedProviders: ["new"], switchableOrgCount: 1 }))
      await wait(() => sync.data.console_state.consoleManagedProviders.includes("new"))
      // 旧一轮的响应迟到：它不能盖掉新一轮已写入的结果。
      gates[0]!(json({ consoleManagedProviders: ["old"], switchableOrgCount: 9 }))
      await Bun.sleep(30)
      expect(sync.data.console_state.consoleManagedProviders).toEqual(["new"])
      expect(sync.data.console_state.switchableOrgCount).toBe(1)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  // 261113 Red 恢复类请求的时序：在本轮第一个 await 之前发出，旧一轮的在途快照被同步
  // 顶掉，不会在 phase1 的 await 窗口里写进 store。
  test("recovery requests start before the blocking phase settles", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let releaseProviders: ((value: Response) => void) | undefined
    const providersPending = new Promise<Response>((resolve) => (releaseProviders = resolve))
    const { app, sync, urls } = await mount(
      (url) => {
        if (url.pathname === "/config/providers") return providersPending
        if (url.pathname === "/permission" || url.pathname === "/question") return json([])
        return undefined
      },
      undefined,
      { waitFor: "none" },
    )

    try {
      // 阻塞阶段（providers）还悬着，首屏仍是 loading；恢复类请求已经各自发出。
      expect(sync.status).toBe("loading")
      await wait(() => urls.some((url) => url.pathname === "/session/status"))
      await wait(() => urls.some((url) => url.pathname === "/question"))
      await wait(() => urls.some((url) => url.pathname === "/permission"))
      releaseProviders!(json({ providers: {}, default: {} }))
      await wait(() => sync.status === "complete")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  // 261113 Red 逐项失败：一个请求永久悬挂时，其它请求的失败仍按端点立即落日志
  // （旧实现要等 allSettled 全部落地才聚合，悬挂会把其余失败一起埋掉）。
  test("optional failures are logged per endpoint while another request hangs", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const warns: { message?: unknown; extra?: Record<string, unknown> }[] = []
    const original = Log.Default.warn
    Log.Default.warn = (message?: unknown, extra?: Record<string, unknown>) => {
      warns.push({ message, extra })
    }
    try {
      const hanging = new Promise<Response>(() => {})
      const { app, sync } = await mount((url) => {
        if (url.pathname === "/mcp") return hanging
        if (url.pathname === "/lsp") return broken()
        if (url.pathname === "/permission" || url.pathname === "/question") return json([])
        return undefined
      })

      try {
        expect(sync.status).toBe("complete")
        await wait(() =>
          warns.some(
            (entry) => entry.message === "tui bootstrap request failed" && entry.extra?.endpoint === "lsp.status",
          ),
        )
        // 悬挂的 mcp.status 还没失败，也就不该有它的失败记录——逐项记录，不是批量。
        expect(warns.some((entry) => entry.extra?.endpoint === "mcp.status")).toBe(false)
      } finally {
        app.renderer.destroy()
      }
    } finally {
      Log.Default.warn = original
      Global.Path.state = previous
    }
  })

  // 261113 Red 未设 throwOnError 的可选请求：HTTP 500 返回 { error } 而不是 reject。
  // 不能当成功回填空值（重启后会把已有状态抹掉），也不能静默——按 endpoint 记失败，
  // store 保留既有数据。
  test("HTTP 500 on an optional endpoint keeps existing data and logs the endpoint", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const warns: { message?: unknown; extra?: Record<string, unknown> }[] = []
    const original = Log.Default.warn
    Log.Default.warn = (message?: unknown, extra?: Record<string, unknown>) => {
      warns.push({ message, extra })
    }
    let failVcs = false
    try {
      const { app, sync, emit } = await mount((url) => {
        if (url.pathname === "/vcs")
          return failVcs ? json({ error: "boom" }, { status: 500 }) : json({ branch: "main" })
        if (url.pathname === "/permission" || url.pathname === "/question") return json([])
        return undefined
      })

      try {
        expect(sync.data.vcs?.branch).toBe("main")
        failVcs = true
        // 第二轮 bootstrap 命中的 /vcs 是 500：envelope 的 error 必须被识别成失败。
        emit({
          directory,
          project: "proj_test",
          payload: { id: "evt_disposed_vcs", type: "server.instance.disposed", properties: { directory } },
        } satisfies GlobalEvent)
        await wait(() =>
          warns.some(
            (entry) => entry.message === "tui bootstrap request failed" && entry.extra?.endpoint === "vcs.get",
          ),
        )
        // 失败不写 store：既有数据保留，没有被空值覆盖。
        expect(sync.data.vcs?.branch).toBe("main")
      } finally {
        app.renderer.destroy()
      }
    } finally {
      Log.Default.warn = original
      Global.Path.state = previous
    }
  })

  // 261113 Red 早期失败必须立即可观测：console/session 在阻塞阶段开始就创建，若它们先
  // reject 而 blocking 悬挂，旧实现要等 startBackground 才接错（未处理 rejection + 无日志）。
  // 同时列表失败不能标 complete（--session --fork 依赖列表），首页仍停在可用的 partial。
  test("early console/session failures are logged during blocking and withhold complete", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const warns: { message?: unknown; extra?: Record<string, unknown> }[] = []
    const original = Log.Default.warn
    Log.Default.warn = (message?: unknown, extra?: Record<string, unknown>) => {
      warns.push({ message, extra })
    }
    let releaseProviders: ((value: Response) => void) | undefined
    const providersPending = new Promise<Response>((resolve) => (releaseProviders = resolve))
    try {
      const { app, sync } = await mount(
        (url) => {
          if (url.pathname === "/config/providers") return providersPending
          if (url.pathname === "/experimental/console") return json({ error: "boom" }, { status: 500 })
          if (url.pathname === "/session") return json({ error: "boom" }, { status: 500 })
          if (url.pathname === "/permission" || url.pathname === "/question") return json([])
          return undefined
        },
        undefined,
        { waitFor: "none" },
      )

      try {
        // 阻塞阶段还悬着：两个先建好的请求已经失败，失败必须在 phase1 期间就按 endpoint 记录。
        expect(sync.status).toBe("loading")
        await wait(() =>
          warns.some(
            (entry) =>
              entry.message === "tui bootstrap request failed" && entry.extra?.endpoint === "console.state",
          ),
        )
        await wait(() =>
          warns.some(
            (entry) => entry.message === "tui bootstrap request failed" && entry.extra?.endpoint === "session.list",
          ),
        )
        releaseProviders!(json({ providers: {}, default: {} }))
        // 列表失败 ⇒ 不标 complete；首页靠 partial 可用（ready = status !== "loading"）。
        await wait(() => sync.status === "partial")
        await Bun.sleep(30)
        expect(sync.status).toBe("partial")
        expect(warns.some((entry) => entry.message === "tui bootstrap complete withheld")).toBe(true)
        expect(sync.data.session).toEqual([])
      } finally {
        app.renderer.destroy()
      }
    } finally {
      Log.Default.warn = original
      Global.Path.state = previous
    }
  })

  // 261113 Red console.state 失败时也不能回填 emptyConsoleState：首次用默认，
  // 重新 bootstrap 失败必须保留已装载的值。
  test("HTTP 500 on console.state keeps the previously loaded value", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const warns: { message?: unknown; extra?: Record<string, unknown> }[] = []
    const original = Log.Default.warn
    Log.Default.warn = (message?: unknown, extra?: Record<string, unknown>) => {
      warns.push({ message, extra })
    }
    let failConsole = false
    try {
      const { app, sync, emit } = await mount((url) => {
        if (url.pathname === "/experimental/console")
          return failConsole
            ? json({ error: "boom" }, { status: 500 })
            : json({ consoleManagedProviders: ["anthropic"], switchableOrgCount: 1 })
        if (url.pathname === "/permission" || url.pathname === "/question") return json([])
        return undefined
      })

      try {
        expect(sync.data.console_state.consoleManagedProviders).toEqual(["anthropic"])
        failConsole = true
        emit({
          directory,
          project: "proj_test",
          payload: { id: "evt_disposed_console", type: "server.instance.disposed", properties: { directory } },
        } satisfies GlobalEvent)
        await wait(() =>
          warns.some(
            (entry) =>
              entry.message === "tui bootstrap request failed" && entry.extra?.endpoint === "console.state",
          ),
        )
        expect(sync.data.console_state.consoleManagedProviders).toEqual(["anthropic"])
        expect(sync.data.console_state.switchableOrgCount).toBe(1)
      } finally {
        app.renderer.destroy()
      }
    } finally {
      Log.Default.warn = original
      Global.Path.state = previous
    }
  })
})
