/** @jsxImportSource @opentui/solid */
// 261113 Red 重连恢复 / 历史翻页边界 / 会话刷新失败保留 —— 三条都走 SyncProvider 的真实
// 编排，只在 context 边界喂假值（同 transcript.tsx 260828 的理由：provider 链带磁盘与
// 渲染副作用，但被测的判定就在 Sync 自己的代码里，绕过外层不影响结论）。
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"
import { projectContext as ProjectContext } from "../../../src/cli/cmd/tui/context/project"
import { argsContext } from "../../../src/cli/cmd/tui/context/args"
import { exitContext } from "../../../src/cli/cmd/tui/context/exit"
import { context as KVContext } from "../../../src/cli/cmd/tui/context/kv"
import { sdkContext } from "../../../src/cli/cmd/tui/context/sdk"

type Sync = ReturnType<typeof useSync>

const DIRECTORY = "/A"

type EventHandler = (event: { payload: unknown; directory: string; project: string; workspace?: string }) => void

function fixture(client: Record<string, unknown>) {
  const handlers: EventHandler[] = []
  const sdk = {
    directory: DIRECTORY,
    url: "http://redcode.internal",
    signal: new AbortController().signal,
    client,
    event: { on: (_type: string, handler: EventHandler) => handlers.push(handler) },
  }
  const project = {
    project: () => "prj_1",
    data: { instance: { path: { worktree: DIRECTORY, directory: DIRECTORY } } },
    instance: { path: () => ({ worktree: DIRECTORY, directory: DIRECTORY }) },
    workspace: { current: () => DIRECTORY, list: () => [] },
  }
  const kv = { get: (_key: string, fallback?: unknown) => fallback }

  let sync!: Sync
  function Capture() {
    sync = useSync()
    return <box />
  }

  const mount = async () => {
    const app = await testRender(() => (
      <KVContext.Provider value={kv as never}>
        <sdkContext.Provider value={sdk as never}>
          <ProjectContext.Provider value={project as never}>
            <argsContext.Provider value={{} as never}>
              <exitContext.Provider value={((async () => {}) as never)}>
                <SyncProvider disabled>
                  <Capture />
                </SyncProvider>
              </exitContext.Provider>
            </argsContext.Provider>
          </ProjectContext.Provider>
        </sdkContext.Provider>
      </KVContext.Provider>
    ))
    await Promise.resolve()
    return { app, emit, sync: () => sync }
  }

  const emit = (payload: { type: string; properties?: unknown }) => {
    for (const handler of handlers) {
      handler({ payload, directory: DIRECTORY, project: "prj_1" })
    }
  }

  return { mount, emit }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("断线重连会重新拉取断线期间产生的权限请求", async () => {
  const permission = { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: [], always: [] }
  let permissionListCalls = 0
  const f = fixture({
    permission: {
      list: async () => {
        permissionListCalls++
        return { data: [permission] }
      },
    },
    question: { list: async () => ({ data: [] }) },
    session: { status: async () => ({ data: {} }) },
  })
  const { app, sync } = await f.mount()

  // 首连由 bootstrap 全量加载，重连才补拉；SSE 没有事件重放，权限请求只能在重连时拉回来。
  f.emit({ type: "server.connected", properties: {} })
  f.emit({ type: "server.connected", properties: {} })
  await tick()

  expect(permissionListCalls).toBe(1)
  expect(sync().data.permission["ses_1"]?.map((item) => item.id)).toEqual(["per_1"])
  app.renderer.destroy()
})

function message(id: string, extra: Record<string, unknown> = {}) {
  return {
    info: { id, sessionID: "ses_1", role: "assistant", time: { created: Number(id.slice(4)) || 1 }, ...extra },
    parts: [],
  }
}

function seed(sync: Sync) {
  // store.message 存的是 Message.Info（parts 另存 store.part），别塞 WithParts。
  sync.set("message", "ses_1", [message("msg_9").info as never])
}

async function earlierPage(page: ReturnType<typeof message>[]) {
  let requests = 0
  const f = fixture({
    session: {
      messages: async () => {
        requests++
        return { data: page }
      },
    },
  })
  const { app, sync } = await f.mount()
  seed(sync())
  const more = await sync().session.loadEarlier("ses_1")
  app.renderer.destroy()
  return { more, ids: sync().data.message["ses_1"]?.map((item) => item.id), requests }
}

test("分页遇到完整摘要就停，不把被压缩的原文放回界面", async () => {
  const { more, ids } = await earlierPage([
    message("msg_1"),
    message("msg_2", { summary: true, finish: "stop" }),
  ])
  expect(more).toBe(false)
  expect(ids).toEqual(["msg_9"])
})

test("finish=length 的截断摘要不是边界，继续向前翻页", async () => {
  const { more, ids } = await earlierPage([
    message("msg_1"),
    message("msg_2", { summary: true, finish: "length" }),
  ])
  expect(more).toBe(true)
  expect(ids).toEqual(["msg_1", "msg_2", "msg_9"])
})

test("finish=unknown 的重复停止摘要不是边界，继续向前翻页", async () => {
  const { more, ids } = await earlierPage([
    message("msg_1"),
    message("msg_2", { summary: true, finish: "unknown" }),
  ])
  expect(more).toBe(true)
  expect(ids).toEqual(["msg_1", "msg_2", "msg_9"])
})

test("刷新会话列表失败时保留旧列表，不按空数组覆盖", async () => {
  let calls = 0
  const f = fixture({
    session: {
      list: async () => {
        calls++
        if (calls === 1) return { data: [{ id: "ses_1", time: { created: 1, updated: 1 } }] }
        throw new Error("500")
      },
    },
  })
  const { app, sync } = await f.mount()

  await sync().session.refresh()
  expect(sync().data.session.map((item) => item.id)).toEqual(["ses_1"])

  await sync().session.refresh()
  expect(sync().data.session.map((item) => item.id)).toEqual(["ses_1"])
  app.renderer.destroy()
})
