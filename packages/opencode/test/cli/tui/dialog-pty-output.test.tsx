/** @jsxImportSource @opentui/solid */
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { DialogPtyOutput } from "../../../src/cli/cmd/tui/component/dialog-pty-output"
import { mountBackgroundDialog } from "../../fixture/background-dialog"

const pty = {
  id: "pty_test",
  title: "logger",
  command: "sh",
  args: [],
  cwd: "/test",
  pid: 123,
  status: "running" as const,
}
function scrollbox(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node
  for (const child of node.getChildren()) {
    const found = scrollbox(child)
    if (found) return found
  }
}

test("read-only output refreshes, preserves scrollback, follows the tail and stops after exit", async () => {
  let calls = 0
  let status = "running"
  const modal = await mountBackgroundDialog(
    (dialog) => <DialogPtyOutput pty={pty} onBack={() => dialog.replace(() => <text>后台</text>)} />,
    {
      pty: {
        get: async () => ({ data: { status } }),
        output: async () => {
          calls++
          return {
            data: {
              output: Array.from({ length: 50 + calls }, (_, i) => `log ${i}`).join("\n"),
              startCursor: 0,
              endCursor: calls,
              truncated: false,
            },
          }
        },
      },
    },
  )
  try {
    await modal.until(() => calls >= 2)
    const scroll = scrollbox(modal.app.renderer.root)!
    expect(scroll).toBeDefined()
    await modal.paint()
    expect(scroll.scrollTop).toBeGreaterThan(0)
    modal.app.mockInput.pressKey("HOME")
    await modal.paint()
    const position = scroll.scrollTop
    expect(position).toBe(0)
    const before = calls
    await modal.until(() => calls > before)
    expect(scroll.scrollTop).toBe(position)
    modal.app.mockInput.pressKey("END")
    await modal.paint()
    const tail = scroll.scrollTop
    await modal.until(() => calls > before + 1)
    expect(scroll.scrollTop).toBeGreaterThan(tail)
    status = "exited"
    await modal.until(() => modal.app.captureCharFrame().includes("已退出"))
    const exitedCalls = calls
    await Bun.sleep(1200)
    expect(calls).toBe(exitedCalls)
    modal.app.mockInput.pressKey("r")
    await modal.until(() => calls === exitedCalls + 1)
    modal.app.mockInput.pressEscape()
    expect(await modal.paint()).toContain("后台")
    await Bun.sleep(1200)
    expect(calls).toBe(exitedCalls + 1)
  } finally {
    modal.app.renderer.destroy()
  }
})

test("closing a running output dialog cancels polling", async () => {
  let calls = 0
  const modal = await mountBackgroundDialog((dialog) => <DialogPtyOutput pty={pty} onBack={() => dialog.clear()} />, {
    pty: {
      get: async () => ({ data: { status: "running" } }),
      output: async () => {
        calls++
        return { data: { output: "tick", startCursor: 0, endCursor: calls, truncated: false } }
      },
    },
  })
  try {
    await modal.until(() => calls === 1)
    modal.app.mockInput.pressEscape()
    await modal.paint()
    await Bun.sleep(1200)
    expect(calls).toBe(1)
  } finally {
    modal.app.renderer.destroy()
  }
})

test("failed refresh retains the snapshot and manual retry reports an orphan without polling", async () => {
  let calls = 0
  let status = "running"
  const modal = await mountBackgroundDialog(() => <DialogPtyOutput pty={pty} onBack={() => {}} />, {
    pty: {
      get: async () => ({ data: { status } }),
      output: async () => {
        calls++
        if (calls === 2) throw new Error("offline")
        return { data: { output: "saved log", startCursor: 8, endCursor: 20, truncated: true } }
      },
    },
  })
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("offline"))
    expect(await modal.paint()).toContain("saved log")
    await Bun.sleep(1200)
    expect(calls).toBe(2)
    status = "orphaned"
    modal.app.mockInput.pressKey("r")
    await modal.until(() => modal.app.captureCharFrame().includes("上次未正常结束"))
    expect(await modal.paint()).not.toContain("offline")
    await Bun.sleep(1200)
    expect(calls).toBe(3)
  } finally {
    modal.app.renderer.destroy()
  }
})
