/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@redcode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@redcode-ai/sdk/v2"

// 260923 Red T4 验收场景：断线期间服务端新增的消息，重连后要补得回来。
// fullSyncedSessions 短路 + 服务端 SSE id: undefined（没有 Last-Event-ID replay）
// 这对组合，让恢复后的当前 session 永久缺一截——server.connected 第二次起触发
// 窄范围补拉：首连归 bootstrap，重连才补。
describe("tui session reconcile", () => {
  test("reconnect pulls the current session snapshot without duplicating messages", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_reconcile"
    let messageCount = 1
    let title = "before"
    let connections = 0
    const gets: string[] = []
    const { app, emit, sync } = await mount((url) => {
      if (!url.pathname.startsWith(`/session/${sessionID}`)) return undefined
      if (url.pathname === `/session/${sessionID}`) {
        gets.push(url.pathname)
        return json({
          id: sessionID,
          title,
          time: { created: 0, updated: 0 },
          version: "1.14.42",
          directory,
          project_id: "proj_test",
        })
      }
      if (url.pathname === `/session/${sessionID}/message`) {
        return json(
          Array.from({ length: messageCount }, (_, i) => ({
            info: { id: `msg_${i + 1}`, sessionID, role: "user", time: { created: i + 1 } },
            parts: [],
          })),
        )
      }
      if (url.pathname === `/session/${sessionID}/todo`) return json([])
      if (url.pathname === `/session/${sessionID}/diff`) return json([])
      return new Response("", { status: 404 })
    })
    const connectedEvent = (): GlobalEvent => ({
      directory: "/tmp/other",
      project: "proj_test",
      payload: { id: `evt_conn_${++connections}`, type: "server.connected", properties: {} },
    })
    try {
      await sync.session.sync(sessionID)
      expect(sync.data.message[sessionID]).toHaveLength(1)

      // 断线期：服务端多了一条消息、标题也变了。fullSyncedSessions 短路让 sync() 拉不回来
      messageCount = 2
      title = "after"
      await sync.session.sync(sessionID)
      expect(sync.data.message[sessionID]).toHaveLength(1)

      // 首连归 bootstrap 全量加载，不补拉
      emit(connectedEvent())
      await Bun.sleep(60)
      expect(sync.data.message[sessionID]).toHaveLength(1)
      expect(gets).toHaveLength(1)

      // 第二次起 = 重连，补拉当前 session
      emit(connectedEvent())
      await wait(() => sync.data.message[sessionID]?.length === 2)

      expect(gets).toHaveLength(2)
      const ids = sync.data.message[sessionID]!.map((m) => m.id)
      expect(ids).toEqual(["msg_1", "msg_2"])
      expect(new Set(ids).size).toBe(2)
      expect(Object.keys(sync.data.part).toSorted()).toEqual(["msg_1", "msg_2"])
      expect(sync.session.get(sessionID)?.title).toBe("after")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
