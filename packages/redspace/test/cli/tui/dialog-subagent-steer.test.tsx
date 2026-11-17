/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { DialogSubagentSteer } from "../../../src/cli/cmd/tui/component/dialog-subagent-steer"
import { clearSteerDraft, getSteerDraft, saveSteerText } from "../../../src/cli/cmd/tui/component/subagent-steer"
import { mountBackgroundDialog } from "../../fixture/background-dialog"

test("keyboard retry preserves request ID, editing changes it, and queued receipts return to background", async () => {
  const sessionID = "keyboard-retry"
  clearSteerDraft(sessionID)
  const requests: { message: string; requestID: string }[] = []
  const modal = await mountBackgroundDialog(
    (dialog) => (
      <DialogSubagentSteer sessionID={sessionID} onDone={() => dialog.replace(() => <text>返回后台成功</text>)} />
    ),
    {
      background: {
        list: async () => ({ data: [{ sessionID, status: "running" }] }),
        steer: async (request: { message: string; requestID: string }) => {
          requests.push(request)
          if (requests.length < 3) throw new Error("simulated offline")
          return { data: { messageID: "message-receipt", state: "queued" } }
        },
      },
      session: { messages: async () => ({ data: [] }) },
    },
  )
  try {
    await modal.until(() => modal.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await modal.app.mockInput.typeText("inspect logs")
    modal.app.mockInput.pressEnter()
    await modal.until(() => modal.app.captureCharFrame().includes("发送失败"))
    modal.app.mockInput.pressKey("r")
    await modal.until(() => requests.length === 2 && modal.app.captureCharFrame().includes("发送失败"))
    expect(requests[1]).toEqual(requests[0])
    modal.app.mockInput.pressKey("e")
    await modal.until(() => modal.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect((modal.app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("inspect logs")
    await modal.app.mockInput.typeText(" first")
    modal.app.mockInput.pressEnter()
    await modal.until(() => modal.app.captureCharFrame().includes("已排队"))
    expect(requests[2].message).toBe("inspect logs first")
    expect(requests[2].requestID).not.toBe(requests[1].requestID)
    expect(await modal.paint()).not.toContain("已送达")
    modal.app.mockInput.pressEscape()
    expect(await modal.paint()).toContain("返回后台成功")
  } finally {
    modal.app.renderer.destroy()
    clearSteerDraft(sessionID)
  }
})

test("escape returns from editing and failure without losing the draft", async () => {
  for (const fail of [false, true]) {
    const sessionID = `keyboard-escape-${fail}`
    clearSteerDraft(sessionID)
    const modal = await mountBackgroundDialog(
      (dialog) => (
        <DialogSubagentSteer sessionID={sessionID} onDone={() => dialog.replace(() => <text>返回后台成功</text>)} />
      ),
      {
        background: {
          list: async () => ({ data: [{ sessionID, status: "running" }] }),
          steer: async () => {
            throw new Error("offline")
          },
        },
      },
    )
    try {
      await modal.until(() => modal.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      await modal.app.mockInput.typeText("keep my draft")
      if (fail) {
        modal.app.mockInput.pressEnter()
        await modal.until(() => modal.app.captureCharFrame().includes("发送失败"))
      }
      modal.app.mockInput.pressEscape()
      expect(await modal.paint()).toContain("返回后台成功")
      expect(getSteerDraft(sessionID).text).toBe("keep my draft")
    } finally {
      modal.app.renderer.destroy()
      clearSteerDraft(sessionID)
    }
  }
})

test("leaving while a receipt is pending cannot start polling after the dialog closes", async () => {
  const sessionID = "keyboard-close-pending"
  clearSteerDraft(sessionID)
  let reads = 0
  let resolve!: (response: { data: { messageID: string; state: "queued" } }) => void
  const receipt = new Promise<{ data: { messageID: string; state: "queued" } }>((done) => {
    resolve = done
  })
  let sending = false
  const modal = await mountBackgroundDialog(
    (dialog) => (
      <DialogSubagentSteer sessionID={sessionID} onDone={() => dialog.replace(() => <text>返回后台成功</text>)} />
    ),
    {
      background: {
        list: async () => ({ data: [{ sessionID, status: "running" }] }),
        steer: () => {
          sending = true
          return receipt
        },
      },
      session: {
        messages: async () => {
          reads++
          return { data: [] }
        },
      },
    },
  )
  try {
    await modal.until(() => modal.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await modal.app.mockInput.typeText("pending request")
    modal.app.mockInput.pressEnter()
    await modal.until(() => sending)
    modal.app.mockInput.pressEscape()
    expect(await modal.paint()).toContain("返回后台成功")
    saveSteerText(sessionID, "a newer unsent draft")
    resolve({ data: { messageID: "late-receipt", state: "queued" } })
    await Bun.sleep(1200)
    expect(reads).toBe(0)
    expect(getSteerDraft(sessionID).text).toBe("a newer unsent draft")
    expect(await modal.paint()).toContain("返回后台成功")
  } finally {
    modal.app.renderer.destroy()
    clearSteerDraft(sessionID)
  }
})
