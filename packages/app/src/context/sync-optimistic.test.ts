import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@redcode-ai/sdk/v2/client"
// 260831 cc 从 ./sync 改指 ./directory-sync。两边曾各有一份同构的 reducer，而**活的是
//   directory-sync 那份**（context/sync.tsx 的三个导出零生产调用者，已删）。测试一直绿着
//   测一份没人跑的副本，真正跑的那份反而没测试兜着——本文件末尾两条回绕用例要修的 bug
//   就是从这个口子进来的。
import { applyOptimisticAdd, applyOptimisticRemove, mergeOptimisticPage } from "./directory-sync"

type Text = Extract<Part, { type: "text" }>

const userMessage = (id: string, sessionID: string, created = 1): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

const textPart = (id: string, sessionID: string, messageID: string): Text => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: id,
})

describe("sync optimistic reducers", () => {
  test("applyOptimisticAdd inserts message in sorted order and stores parts", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_2", sessionID)] },
      part: {} as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_1", sessionID),
      parts: [textPart("prt_2", sessionID, "msg_1"), textPart("prt_1", sessionID, "msg_1")],
    })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(draft.part.msg_1?.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
  })

  test("applyOptimisticRemove removes message and part entries", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_2", sessionID)] },
      part: {
        msg_1: [textPart("prt_1", sessionID, "msg_1")],
        msg_2: [textPart("prt_2", sessionID, "msg_2")],
      } as Record<string, Part[] | undefined>,
    }

    applyOptimisticRemove(draft, { sessionID, messageID: "msg_1" })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_2"])
    expect(draft.part.msg_1).toBeUndefined()
    expect(draft.part.msg_2).toHaveLength(1)
  })

  test("mergeOptimisticPage keeps pending messages in fetched timelines", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_1", sessionID)],
        part: [{ id: "msg_1", part: [textPart("prt_1", sessionID, "msg_1")] }],
        complete: true,
      },
      [{ message: userMessage("msg_2", sessionID), parts: [textPart("prt_2", sessionID, "msg_2")] }],
    )

    expect(page.session.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_2"])
    expect(page.confirmed).toEqual([])
    expect(page.complete).toBe(true)
  })

  test("mergeOptimisticPage keeps missing optimistic parts until the server has them", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [{ id: "msg_2", part: [textPart("prt_2", sessionID, "msg_2")] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
    expect(page.confirmed).toEqual([])
  })

  test("mergeOptimisticPage confirms echoed messages once all parts arrive", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [
          {
            id: "msg_2",
            part: [{ ...textPart("prt_1", sessionID, "msg_2"), text: "server" }, textPart("prt_2", sessionID, "msg_2")],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.confirmed).toEqual(["msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part).toMatchObject([
      { id: "prt_1", type: "text", text: "server" },
      { id: "prt_2", type: "text", text: "prt_2" },
    ])
  })

  // 下面两条钉的是 #109 的 ID 回绕：ID 是时间编码且 795 天回绕一次，回绕后**新**消息的 ID
  // 字典序反而**小于**旧消息。取自真实会话 ses_0536c127…：7/29 的 msg_fac… 与 8/31 的
  // msg_001a…，后者字典序在前。按 ID 排/二分都会把新的一轮甩到会话最前面。
  const OLD = "msg_fac0d1f2e3b4A1b2C3d4E5f6" // 7/29
  const NEW = "msg_001a05570000A1b2C3d4E5f6" // 8/31，字典序 < OLD

  test("applyOptimisticAdd 按时间序插入，不按 ID 字典序（ID 回绕）", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage(OLD, sessionID, 100)] },
      part: {} as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage(NEW, sessionID, 200),
      parts: [textPart("prt_1", sessionID, NEW)],
    })

    // 新消息排在末尾。若按 ID 字典序会得到 [NEW, OLD]——哥哥 260830 就是这样以为消息丢了。
    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual([OLD, NEW])
  })

  test("mergeOptimisticPage 在时间序数组上仍认得已存在的消息（不能二分）", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        // 时间序，不是字典序——服务端就是这么返回的
        session: [userMessage(OLD, sessionID, 100), userMessage(NEW, sessionID, 200)],
        part: [{ id: NEW, part: [textPart("prt_1", sessionID, NEW)] }],
        complete: true,
      },
      [{ message: userMessage(NEW, sessionID, 200), parts: [textPart("prt_1", sessionID, NEW)] }],
    )

    // 二分会 found=false → 重复插入且 confirmed 空，乐观气泡永不消失
    expect(page.session.map((x) => x.id)).toEqual([OLD, NEW])
    expect(page.confirmed).toEqual([NEW])
  })
})
