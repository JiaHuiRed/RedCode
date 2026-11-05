import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { BackgroundStore } from "@/background/store"

describe("background.store", () => {
  test("turns stale running records into failures on hydrate", () => {
    const records = BackgroundStore.hydrate({
      version: 1,
      saved_at: 500,
      records: [
        { id: "job_a", type: "task", status: "running", started_at: 100 },
        { id: "job_b", type: "task", status: "completed", started_at: 200, completed_at: 300 },
      ],
    })

    expect(records[0]?.status).toBe("error")
    expect(records[0]?.completed_at).toBe(500)
    expect(records[0]?.error).toContain("未正常结束")
    expect(records[1]?.status).toBe("completed")
  })

  test("round-trips records and drops output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "redcode-bg-store-"))
    try {
      const snapshot = await Effect.runPromise(
        BackgroundStore.write(dir, "/workspace/a", [
          {
            id: "job_1",
            type: "task",
            title: "hello",
            status: "completed",
            started_at: 1,
            completed_at: 2,
            output: "x".repeat(2000),
          },
        ]).pipe(Effect.andThen(BackgroundStore.read(dir, "/workspace/a"))),
      )

      expect(snapshot?.records).toHaveLength(1)
      expect(snapshot?.records[0]?.title).toBe("hello")
      expect(JSON.stringify(snapshot)).not.toContain("xxxx")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps running records when finished records exceed the cap", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "redcode-bg-keep-"))
    try {
      const finished = Array.from({ length: 60 }, (_, index) => ({
        id: `job_${index}`,
        type: "task",
        status: "completed" as const,
        started_at: 100 + index,
        completed_at: 200 + index,
      }))
      const snapshot = await Effect.runPromise(
        BackgroundStore.write(dir, "/workspace/keep", [
          { id: "job_running", type: "task", status: "running", started_at: 1 },
          ...finished,
        ]).pipe(Effect.andThen(BackgroundStore.read(dir, "/workspace/keep"))),
      )

      // 运行中的任务不占用完成态的 50 条配额，否则跑得最久的任务会被挤出快照。
      expect(snapshot?.records).toHaveLength(51)
      expect(snapshot?.records.some((record) => record.id === "job_running")).toBe(true)
      expect(snapshot?.records.filter((record) => record.status === "completed")).toHaveLength(50)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("ignores a corrupt state file instead of failing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "redcode-bg-corrupt-"))
    try {
      await Effect.runPromise(BackgroundStore.write(dir, "/workspace/corrupt", []))
      const [name] = await readdir(dir)
      await Bun.write(path.join(dir, name!), "{ not json")

      expect(await Effect.runPromise(BackgroundStore.read(dir, "/workspace/corrupt"))).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns nothing when the workspace has no state file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "redcode-bg-empty-"))
    try {
      expect(await Effect.runPromise(BackgroundStore.read(dir, "/workspace/missing"))).toBeUndefined()
      expect(BackgroundStore.hydrate(undefined)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("isolates namespaced snapshots from the default file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "redcode-bg-ns-"))
    try {
      await Effect.runPromise(
        BackgroundStore.write(
          dir,
          "/workspace/ns",
          [{ id: "pty_1", type: "pty", status: "running", started_at: 1 }],
          "pty",
        ),
      )

      // 任务快照与 pty 快照各自整写自己的文件：pty 落盘后默认文件仍读不到。
      expect(await Effect.runPromise(BackgroundStore.read(dir, "/workspace/ns"))).toBeUndefined()
      const snapshot = await Effect.runPromise(BackgroundStore.read(dir, "/workspace/ns", "pty"))
      expect(snapshot?.records).toHaveLength(1)
      expect(snapshot?.records[0]?.type).toBe("pty")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
