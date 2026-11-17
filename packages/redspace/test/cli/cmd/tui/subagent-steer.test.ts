import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearSteerDraft,
  getSteerDraft,
  resetSteerDrafts,
  saveSteerText,
  steerDelivery,
  steerRequest,
  steerStateText,
  validateSteerMessage,
  STEER_MESSAGE_MAX_BYTES,
} from "../../../../src/cli/cmd/tui/component/subagent-steer"

// 261116 Red A03：草稿按目标会话保留；同一正文重试用同一个 requestID（服务端幂等），
// 改正文才换 ID。回执只按持久化 delivery 展示，「已送达」不代表已执行。
describe("steer drafts", () => {
  beforeEach(() => resetSteerDrafts())

  test("drops nothing when the dialog is closed mid-edit", () => {
    saveSteerText("ses_child", "先别查归档")
    expect(getSteerDraft("ses_child").text).toBe("先别查归档")
  })

  test("keeps the requestID for retries of the same text and rotates on edit", () => {
    const first = steerRequest("ses_child", "重点看 data_sync.py")
    const retry = steerRequest("ses_child", "重点看 data_sync.py")
    expect(retry.requestID).toBe(first.requestID)

    const edited = steerRequest("ses_child", "重点看 data_sync.py，先别看归档")
    expect(edited.requestID).not.toBe(first.requestID)
  })

  test("clear removes the stored draft", () => {
    saveSteerText("ses_child", "x")
    clearSteerDraft("ses_child")
    expect(getSteerDraft("ses_child").text).toBe("")
  })
})

describe("validateSteerMessage", () => {
  test("rejects blank and oversized messages", () => {
    expect(validateSteerMessage("  ", "req")).toBeTruthy()
    expect(validateSteerMessage("a".repeat(STEER_MESSAGE_MAX_BYTES + 1), "req")).toContain("上限")
    expect(validateSteerMessage("好的", "req")).toBeUndefined()
  })
})

describe("delivery receipt", () => {
  test("only delivered counts as delivered", () => {
    expect(steerDelivery("delivered")).toBe("delivered")
    for (const value of ["queued", "pending_steer", "steer", undefined]) expect(steerDelivery(value)).toBe("queued")
  })

  test("states that delivered is delivery only", () => {
    expect(steerStateText("delivered")).toContain("不代表模型已理解或执行完成")
    expect(steerStateText("queued")).toContain("下一个安全执行点")
    expect(steerStateText("failed")).toContain("原文已保留")
  })
})
