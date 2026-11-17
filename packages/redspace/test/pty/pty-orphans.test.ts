import { afterAll, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { BackgroundStore } from "@/background/store"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Pty } from "../../src/pty"
import { PtyID } from "../../src/pty/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// 261105 Red 快照落临时目录：这些用例读写状态文件，不能落到真实 data 目录。
const store = await mkdtemp(path.join(os.tmpdir(), "redcode-pty-orphans-"))
afterAll(() => rm(store, { recursive: true, force: true }))

const it = testEffect(
  Pty.layer.pipe(
    Layer.provideMerge(Bus.layer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provideMerge(Plugin.defaultLayer),
    Layer.provideMerge(Layer.succeed(BackgroundStore.directory, store)),
  ),
)

describe("pty.orphans", () => {
  it.instance("recovers stale running records as orphaned entries", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* BackgroundStore.write(
        store,
        test.directory,
        [
          {
            id: "pty_stale",
            type: "pty",
            title: "上次没关的终端",
            status: "running",
            started_at: 100,
            metadata: { command: "/bin/bash", args: ["-l"], cwd: test.directory, pid: 4242 },
          },
          // 完成态与身份不对的记录不归位成孤儿
          { id: "pty_done", type: "pty", status: "completed", started_at: 50, completed_at: 60 },
          { id: "job_x", type: "task", status: "running", started_at: 70 },
        ],
        "pty",
      )

      const pty = yield* Pty.Service
      const list = yield* pty.list()

      expect(list).toHaveLength(1)
      const orphan = list[0]!
      expect(orphan.id).toBe(PtyID.ascending("pty_stale"))
      expect(orphan.status).toBe("orphaned")
      expect(orphan.title).toBe("上次没关的终端")
      expect(orphan.command).toBe("/bin/bash")
      expect(orphan.pid).toBe(4242)
      expect(orphan.cwd).toBe(test.directory)
      expect(yield* pty.get(orphan.id)).toEqual(orphan)
    }),
  )

  it.instance("drops records with malformed metadata instead of guessing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* BackgroundStore.write(
        store,
        test.directory,
        [
          { id: "pty_bad", type: "pty", status: "running", started_at: 10, metadata: { command: "/bin/sh" } },
          { id: "pty_worse", type: "pty", status: "running", started_at: 11, metadata: { pid: "4242" } },
        ],
        "pty",
      )

      const pty = yield* Pty.Service
      expect(yield* pty.list()).toEqual([])
    }),
  )

  // 真实 spawn 在 Windows 上跳过，与 pty-session.test.ts 同门槛。
  const liveIt = process.platform === "win32" ? it.instance.skip : it.instance
  liveIt("persists a running record on create and clears it on remove", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const pty = yield* Pty.Service
      const created = yield* pty.create({})
      yield* Effect.gen(function* () {
        const afterCreate = yield* BackgroundStore.read(store, test.directory, "pty")
        expect(afterCreate?.records).toHaveLength(1)
        expect(afterCreate?.records[0]?.metadata).toMatchObject({ pid: created.pid, command: created.command })

        yield* pty.remove(created.id)
        const afterRemove = yield* BackgroundStore.read(store, test.directory, "pty")
        expect(afterRemove?.records).toEqual([])
      }).pipe(
        // 261105 Red 断言失败也要把终端收掉，不给测试进程留子进程
        Effect.onError(() => pty.remove(created.id).pipe(Effect.ignore)),
      )
    }),
  )
})
