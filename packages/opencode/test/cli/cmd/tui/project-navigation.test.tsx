/** @jsxImportSource @opentui/solid */
/**
 * 261114 Red 项目导航活动摘要：Sync bootstrap 完成时播种快照（seedActivity），之后
 * 由实时事件增量维护。用例覆盖：播种初值、事件续维护、切换目录后迟到播种作废、
 * remote 模式不播种。
 */
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { onMount } from "solid-js"
import { testRender } from "@opentui/solid"
import { Global } from "@redcode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json, wait, type FetchHandler } from "./sync-fixture"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { ProjectNavigationProvider, useProjectNavigation } from "../../../../src/cli/cmd/tui/context/project-navigation"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
import { ToastProvider } from "../../../../src/cli/cmd/tui/ui/toast"
import type { GlobalEvent } from "@redcode-ai/sdk/v2"

function statusEvent(sessionID: string, status: "idle" | "busy"): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_status_${sessionID}`, type: "session.status", properties: { sessionID, status: { type: status } } },
  }
}

function askedEvent(kind: "permission" | "question", id: string, sessionID: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload:
      kind === "permission"
        ? { id: `evt_${id}`, type: "permission.asked", properties: { id, sessionID, permission: "file", patterns: [], metadata: {}, always: [] } }
        : { id: `evt_${id}`, type: "question.asked", properties: { id, sessionID, questions: [] } },
  }
}

function repliedEvent(kind: "permission" | "question", requestID: string, sessionID: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload:
      kind === "permission"
        ? { id: `evt_reply_${requestID}`, type: "permission.replied", properties: { sessionID, requestID, reply: "once" } }
        : { id: `evt_reply_${requestID}`, type: "question.replied", properties: { sessionID, requestID, answers: [] } },
  }
}

async function mountNavigation(
  override?: FetchHandler,
  nav?: { local?: boolean; directory?: string | undefined },
) {
  const calls = createFetch(override)
  const events = createEventSource()
  let navigation!: NonNullable<ReturnType<typeof useProjectNavigation>>
  let sync!: ReturnType<typeof useSync>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    navigation = useProjectNavigation()!
    sync = useSync()
    onMount(() => done())
    return <box />
  }

  const app = await testRender(() => (
    <ArgsProvider>
      <ExitProvider>
        <KVProvider>
          <ToastProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <ProjectNavigationProvider
                directory={nav?.directory !== undefined ? nav.directory : directory}
                config={createTuiResolvedConfig()}
                args={{}}
                local={nav?.local ?? true}
              >
                <ProjectProvider>
                  <SyncProvider>
                    <Probe />
                  </SyncProvider>
                </ProjectProvider>
              </ProjectNavigationProvider>
            </SDKProvider>
          </ToastProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return { app, emit: events.emit, navigation, sync }
}

const seedFetch: FetchHandler = (url) => {
  if (url.pathname === "/session/status") return json({ ses_a: { type: "busy" }, ses_b: { type: "busy" } })
  if (url.pathname === "/permission")
    return json([{ id: "per_1", sessionID: "ses_a", permission: "file", patterns: [], metadata: {}, always: [] }])
  if (url.pathname === "/question") return json([])
}

describe("project navigation activity", () => {
  test("bootstrap seed fills the activity summary", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const { app, navigation } = await mountNavigation(seedFetch)
    try {
      expect(navigation.summary(directory)).toEqual({ busy: 2, waiting: 1 })
      expect(navigation.waitingSession(directory)).toBe("ses_a")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("events keep maintaining the summary after the seed", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const { app, emit, navigation } = await mountNavigation(seedFetch)
    try {
      expect(navigation.summary(directory)).toEqual({ busy: 2, waiting: 1 })

      emit(statusEvent("ses_a", "idle"))
      await wait(() => navigation.summary(directory).busy === 1)
      emit(repliedEvent("permission", "per_1", "ses_a"))
      await wait(() => navigation.summary(directory).waiting === 0)

      emit(askedEvent("question", "q_1", "ses_c"))
      await wait(() => navigation.summary(directory).waiting === 1)
      expect(navigation.waitingSession(directory)).toBe("ses_c")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("stale seed after switching away is rejected", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    await using target = await tmpdir()

    const { app, navigation } = await mountNavigation(seedFetch)
    try {
      expect(navigation.summary(directory)).toEqual({ busy: 2, waiting: 1 })
      expect(await navigation.switchTo(target.path)).toBe(true)
      const switched = await fs.realpath(target.path)
      expect(navigation.directory()).toBe(switched)

      // 旧目录 provider 的迟到播种：目录已不是当前工作区，必须整体作废——
      // 摘要保留切换前事件维护的原值，不带出 ses_late。
      navigation.seedActivity(directory, { busy: ["ses_late"], requests: [{ id: "req_late", sessionID: "ses_late" }] })
      expect(navigation.summary(directory)).toEqual({ busy: 2, waiting: 1 })
      expect(navigation.waitingSession(directory)).toBe("ses_a")

      // 当前目录播种放行
      navigation.seedActivity(switched, { busy: ["ses_now"], requests: [] })
      expect(navigation.summary(switched)).toEqual({ busy: 1, waiting: 0 })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("remote mode does not seed", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const { app, navigation } = await mountNavigation(seedFetch, { local: false, directory: undefined })
    try {
      expect(navigation.enabled).toBe(false)
      expect(navigation.summary(directory)).toEqual({ busy: 0, waiting: 0 })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
