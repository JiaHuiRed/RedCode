import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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

  test("returns nothing when the workspace has no state file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "redcode-bg-empty-"))
    try {
      expect(await Effect.runPromise(BackgroundStore.read(dir, "/workspace/missing"))).toBeUndefined()
      expect(BackgroundStore.hydrate(undefined)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
