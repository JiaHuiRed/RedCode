/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@redcode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@redcode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  // 260904 cc 进会话的 diff fetch 回来了，但只拉元数据（patch=false）：断言从「不请求」改成「只请求不带正文的那种」。
  test("opening a session fetches its diff without patch bodies", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_large"
    const requests: string[] = []
    const sessionPayload = {
      id: sessionID,
      title: "large diff",
      time: { created: 0, updated: 0 },
      version: "1.14.42",
      directory,
      project_id: "proj_test",
    }
    const { app, sync } = await mount((url) => {
      if (!url.pathname.startsWith(`/session/${sessionID}`)) return undefined
      requests.push(url.pathname + url.search)
      if (url.pathname === `/session/${sessionID}`) return json(sessionPayload)
      if (url.pathname === `/session/${sessionID}/message`) return json([])
      if (url.pathname === `/session/${sessionID}/todo`) return json([])
      if (url.pathname === `/session/${sessionID}/diff`) return json([])
      return new Response("", { status: 404 })
    })
    try {
      await sync.session.sync(sessionID)
      const diffs = requests.filter((r) => r.startsWith(`/session/${sessionID}/diff`))
      expect(diffs).toHaveLength(1)
      expect(new URL(diffs[0]!, "http://test").searchParams.get("patch")).toBe("false")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  // 260825 cc 断言从 scope="project" 改为 "global"，跟上 0.4.4 的行为变更。
  // f25f0b29「Session 全局 scope」有意把"关掉目录过滤"的语义从"放宽到本项目"
  // 改成"放宽到全局"，同批改了服务端 session.ts、HTTP 路由与 SDK 生成类型共
  // 5 个文件，CHANGELOG 作为新功能记着（"Session.list() 支持 scope: 'global'
  // 列出所有项目的会话（不限于当前项目）"）。本测试来自仓库初始快照 d6d579c4，
  // 从没跟着更新，此后一直红着——是测试陈旧，不是 sync.tsx:137 写错。
  test("refresh scopes sessions by default and lists global sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/redcode")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("global")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount()

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
