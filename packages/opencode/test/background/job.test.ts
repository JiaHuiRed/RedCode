import { afterAll, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { BackgroundStore } from "@/background/store"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

// 261104 Red 落盘目录指到临时目录：这些用例每次都会写状态文件，不能落到真实 data 目录。
const store = await mkdtemp(path.join(os.tmpdir(), "redcode-bg-store-"))
afterAll(() => rm(store, { recursive: true, force: true }))

const it = testEffect(Layer.mergeAll(BackgroundJob.defaultLayer, Layer.succeed(BackgroundStore.directory, store)))

describe("background.job", () => {
  it.instance("tracks started jobs through completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        title: "test job",
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job.id.startsWith("job_")).toBe(true)
      expect(job.status).toBe("running")
      expect(job.title).toBe("test job")

      yield* Deferred.succeed(latch, undefined)
      const done = yield* jobs.wait({ id: job.id })

      expect(done.timedOut).toBe(false)
      expect(done.info?.status).toBe("completed")
      expect(done.info?.output).toBe("done")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([job.id])
    }),
  )

  it.instance("returns a running snapshot when wait times out", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never,
      })

      const result = yield* jobs.wait({ id: job.id, timeout: 1 })

      expect(result.timedOut).toBe(true)
      expect(result.info?.status).toBe("running")
    }),
  )

  it.instance("deduplicates concurrent starts for a running id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const id = "job_test"
      const [first, second] = yield* Effect.all(
        [
          jobs.start({
            id,
            type: "test",
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          jobs.start({
            id,
            type: "test",
            run: Effect.fail(new Error("duplicate started")),
          }),
        ],
        { concurrency: "unbounded" },
      )

      yield* Deferred.await(started)

      expect(first.id).toBe(id)
      expect(second.id).toBe(id)
      expect(first.status).toBe("running")
      expect(second.status).toBe("running")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([id])

      yield* jobs.cancel(id)
    }),
  )

  it.instance("records failed jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.fail(new Error("boom")),
      })

      const result = yield* jobs.wait({ id: job.id })

      expect(result.info?.status).toBe("error")
      expect(result.info?.error).toBe("boom")
    }),
  )

  it.instance("can cancel running jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const interrupted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      const cancelled = yield* jobs.cancel(job.id)

      expect(cancelled?.status).toBe("cancelled")
      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("returns immutable snapshots", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        metadata: { value: "initial" },
        run: Effect.succeed("done"),
      })

      if (job.metadata) job.metadata.value = "changed"

      expect((yield* jobs.get(job.id))?.metadata?.value).toBe("initial")
    }),
  )

  it.instance("persists finished jobs for the next launch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "test", title: "persisted", run: Effect.succeed("done") })
      yield* jobs.wait({ id: job.id })

      const snapshot = yield* BackgroundStore.read(store, test.directory)
      const record = snapshot?.records.find((item) => item.id === job.id)

      expect(record?.status).toBe("completed")
      expect(record?.title).toBe("persisted")
      // output 可能到数 MB，落盘只留定位与状态
      expect(JSON.stringify(record)).not.toContain("done")
    }),
  )

  it.instance("evicts oldest finished jobs beyond the cap", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      // 260909 Red FINISHED_MAX = 50：完成态全程至多保留 50 条（output 是子代理全文，
      // 此前只进不出），挤出的是最早的完成态；每个任务都 wait 到完成再起下一个，
      // 保证 prune 看到的是确定的完成态序列
      const first = yield* jobs.start({ type: "test", run: Effect.succeed("oldest") })
      yield* jobs.wait({ id: first.id })
      for (let i = 0; i < 60; i++) {
        const job = yield* jobs.start({ type: "test", run: Effect.succeed(`out-${i}`) })
        yield* jobs.wait({ id: job.id })
      }

      const list = yield* jobs.list()

      expect(list.length).toBeLessThanOrEqual(50)
      expect(list.every((item) => item.status !== "running")).toBe(true)
      expect(yield* jobs.get(first.id)).toBeUndefined()
    }),
  )
})
