import { afterAll, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { BackgroundStore } from "@/background/store"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Pty } from "@/pty"
import { PtyID } from "@/pty/schema"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// 261116 Red 快照状态读写临时目录；不碰真实 data 目录。
const store = await mkdtemp(path.join(os.tmpdir(), "redcode-pty-output-"))
afterAll(() => rm(store, { recursive: true, force: true }))

const it = testEffect(
  Pty.layer.pipe(
    Layer.provideMerge(Bus.layer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provideMerge(Plugin.defaultLayer),
    Layer.provideMerge(Layer.succeed(BackgroundStore.directory, store)),
  ),
)

const pauseCommand = process.platform === "win32" ? "cmd.exe" : "/bin/sh"
const pauseArgs = process.platform === "win32" ? ["/c", "echo READY & pause >nul"] : ["-c", "echo READY; read x"]
const shortArgs = process.platform === "win32" ? ["/c", "echo SHORT_TAIL_MARKER"] : ["-c", "echo SHORT_TAIL_MARKER"]
const largeArgs =
  process.platform === "win32"
    ? ["/c", "for /l %i in (1,1,2000) do @echo 0123456789ABCDEF"]
    : ["-c", "yes 0123456789ABCDEF | head -c 33000"]

const isOk = (value: unknown): value is { type: "ok"; exited: boolean; output: string; startCursor: number; endCursor: number; truncated: boolean } =>
  !!value && typeof value === "object" && "type" in value && value.type === "ok"

describe("pty output snapshot", () => {
  it.instance("returns a read-only bounded snapshot without writing to the PTY", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const created = yield* Effect.acquireRelease(
        pty.create({ command: pauseCommand, args: pauseArgs, title: "read-only" }),
        (info) => pty.remove(info.id).pipe(Effect.ignore),
      )
      const first = yield* pollWithTimeout(
        Effect.gen(function* () {
          const result = yield* pty.output(created.id)
          return isOk(result) && result.output.includes("READY") ? result : undefined
        }),
        "PTY never produced its startup output",
      )
      // 等到连续两次 endCursor 一致，确认没有新的终端输出；再读一次必须不变。
      const stable = yield* Effect.gen(function* () {
        let previous = first.endCursor
        while (true) {
          yield* Effect.sleep("150 millis")
          const result = yield* pty.output(created.id)
          if (!isOk(result)) return yield* Effect.fail(new Error("PTY output became unavailable"))
          if (result.endCursor === previous) return result
          previous = result.endCursor
        }
      }).pipe(Effect.timeout("5 seconds"))
      const after = yield* pty.output(created.id)
      expect(after.type).toBe("ok")
      if (!isOk(after)) return yield* Effect.die("expected output")
      expect(after.endCursor).toBe(stable.endCursor)
      expect(after.output).toBe(stable.output)
      const info = yield* pty.get(created.id)
      expect(info?.status).toBe("running")
      expect((yield* pty.list()).some((item) => item.id === created.id)).toBe(true)
    }),
  )

  it.instance("keeps recent exited Info and tail visible in list/get after exit", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const created = yield* Effect.acquireRelease(
        pty.create({ command: pauseCommand === "cmd.exe" ? "cmd.exe" : "/bin/sh", args: shortArgs, title: "short" }),
        (info) => pty.remove(info.id).pipe(Effect.ignore),
      )
      const result = yield* pollWithTimeout(
        Effect.gen(function* () {
          const output = yield* pty.output(created.id)
          return isOk(output) && output.exited ? output : undefined
        }),
        "short PTY did not retain an exited tail",
      )
      expect(result.output).toContain("SHORT_TAIL_MARKER")
      expect(result.truncated).toBe(false)
      const info = yield* pty.get(created.id)
      expect(info?.status).toBe("exited")
      const listed = (yield* pty.list()).find((item) => item.id === created.id)
      expect(listed?.status).toBe("exited")
      const again = yield* pty.output(created.id)
      expect(again.type).toBe("ok")
      if (!isOk(again)) return yield* Effect.die("expected exited tail")
      expect(again.output).toContain("SHORT_TAIL_MARKER")
    }),
  )

  it.instance("caps exited tail output and reports truncation", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const created = yield* Effect.acquireRelease(
        pty.create({ command: pauseCommand, args: largeArgs, title: "large" }),
        (info) => pty.remove(info.id).pipe(Effect.ignore),
      )
      const result = yield* pollWithTimeout(
        Effect.gen(function* () {
          const output = yield* pty.output(created.id)
          return isOk(output) && output.exited && output.truncated ? output : undefined
        }),
        "large PTY output was not retained as a truncated tail",
      )
      expect(result.output.length).toBe(32_000)
      expect(result.endCursor - result.startCursor).toBe(result.output.length)
      expect(result.output).toContain("0123456789ABCDEF")
      expect((yield* pty.get(created.id))?.status).toBe("exited")
    }),
  )

  it.instance("explicit remove discards its own exited snapshot without touching other exited ids", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const first = yield* Effect.acquireRelease(
        pty.create({ command: pauseCommand, args: shortArgs, title: "first" }),
        (info) => pty.remove(info.id).pipe(Effect.ignore),
      )
      const second = yield* Effect.acquireRelease(
        pty.create({ command: pauseCommand, args: shortArgs, title: "second" }),
        (info) => pty.remove(info.id).pipe(Effect.ignore),
      )
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const one = yield* pty.output(first.id)
          const two = yield* pty.output(second.id)
          return isOk(one) && isOk(two) && one.exited && two.exited ? true : undefined
        }),
        "short PTYs did not exit",
      )
      yield* pty.remove(first.id)
      expect(yield* pty.get(first.id)).toBeUndefined()
      expect((yield* pty.output(first.id)).type).toBe("not_found")
      expect((yield* pty.get(second.id))?.status).toBe("exited")
      expect((yield* pty.list()).find((item) => item.id === second.id)?.status).toBe("exited")
    }),
  )

  it.instance("reports unknown and orphaned terminals explicitly", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* BackgroundStore.write(
        store,
        instance.directory,
        [
          {
            id: "pty_output_orphan",
            type: "pty",
            title: "orphan",
            status: "running",
            started_at: 1,
            metadata: { command: "/bin/bash", args: [], cwd: instance.directory, pid: 4242 },
          },
        ],
        "pty",
      )
      const pty = yield* Pty.Service
      const orphanID = PtyID.ascending("pty_output_orphan")
      expect((yield* pty.get(orphanID))?.status).toBe("orphaned")
      expect((yield* pty.output(orphanID)).type).toBe("orphaned")
      expect((yield* pty.output(PtyID.ascending("pty_missing"))).type).toBe("not_found")
    }),
  )

  it.instance("explicit remove of a running terminal leaves no exited snapshot", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const created = yield* pty.create({ command: pauseCommand, args: pauseArgs, title: "remove-live" })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const result = yield* pty.output(created.id)
          return isOk(result) && result.output.includes("READY") ? true : undefined
        }),
        "PTY never produced its startup output",
      )
      yield* pty.remove(created.id)
      expect(yield* pty.get(created.id)).toBeUndefined()
      expect((yield* pty.output(created.id)).type).toBe("not_found")
    }),
  )
})
