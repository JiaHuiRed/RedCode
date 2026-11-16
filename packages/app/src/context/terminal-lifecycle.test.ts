import { describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import * as platform from "./platform"
import { createWorkspaceTerminalSession } from "./terminal"

mock.module("./platform", () => ({ ...platform, usePlatform: () => ({ platform: "web" }) }))

function workspace(remove: (id: string) => void = () => {}) {
  const removed: string[] = []
  const updated: string[] = []
  const sdk = {
    event: { on: () => () => {} },
    client: {
      pty: {
        get: async ({ ptyID }: { ptyID: string }) => ({ data: { id: ptyID, title: "server", status: "running" } }),
        create: async () => ({ data: { id: "owned", title: "Terminal 1" } }),
        update: async ({ ptyID }: { ptyID: string }) => {
          updated.push(ptyID)
        },
        remove: async ({ ptyID }: { ptyID: string }) => {
          removed.push(ptyID)
          remove(ptyID)
        },
      },
    },
  }
  return createRoot((dispose) => ({
    terminal: createWorkspaceTerminalSession(
      sdk as unknown as Parameters<typeof createWorkspaceTerminalSession>[0],
      crypto.randomUUID(),
    ),
    removed,
    updated,
    dispose,
  }))
}

describe("background terminal lifecycle", () => {
  test("closing and reopening a background view preserves the running server", async () => {
    const server = Bun.spawn(
      [process.execPath, "-e", 'Bun.serve({port:0,fetch:()=>new Response("alive")}); console.log("ready")'],
      { stdout: "pipe", stderr: "pipe" },
    )
    const reader = server.stdout.getReader()
    await reader.read()
    reader.releaseLock()
    const state = workspace(() => server.kill())
    try {
      await state.terminal.attach("server")
      await state.terminal.attach("server")
      expect(state.terminal.all()).toHaveLength(1)
      await state.terminal.close("server")
      expect(state.removed).toEqual([])
      expect(() => process.kill(server.pid, 0)).not.toThrow()
      expect(state.terminal.active()).toBeUndefined()
      await state.terminal.attach("server")
      expect(state.terminal.active()).toBe("server")
      expect(state.terminal.all()).toHaveLength(1)
    } finally {
      state.dispose()
      server.kill()
      await server.exited
    }
  })

  test("owned terminals retain close semantics even when selected from background", async () => {
    const state = workspace()
    try {
      state.terminal.new()
      await Promise.resolve()
      await state.terminal.attach("owned")
      await state.terminal.attach("background")
      await state.terminal.close("background")
      expect(state.terminal.active()).toBe("owned")
      await state.terminal.close("owned")
      await state.terminal.close("owned")
      expect(state.removed).toEqual(["owned"])
    } finally {
      state.dispose()
    }
  })

  test("unmount persistence cannot update a detached terminal", async () => {
    const state = workspace()
    try {
      await state.terminal.attach("server")
      await state.terminal.close("server")
      state.terminal.update({ id: "server", rows: 20, cols: 80 })
      expect(state.updated).toEqual([])
    } finally {
      state.dispose()
    }
  })
})
