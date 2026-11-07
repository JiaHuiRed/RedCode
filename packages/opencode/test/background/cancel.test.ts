import { afterAll, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Layer } from "effect"
import { BackgroundCancel } from "@/background/cancel"
import { BackgroundJob } from "@/background/job"
import { BackgroundStore } from "@/background/store"
import { MessageV2 } from "@/session/message-v2"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { pollWithTimeout, testEffect } from "../lib/effect"

// 261105 Red 落盘目录指到临时目录：取消会写状态文件，不能落到真实 data 目录。
const store = await mkdtemp(path.join(os.tmpdir(), "redcode-bg-cancel-"))
afterAll(() => rm(store, { recursive: true, force: true }))

const it = testEffect(
  Layer.mergeAll(
    BackgroundCancel.defaultLayer,
    // defaultLayer 用 Layer.provide 收编依赖，被收编的服务不会从合并层里暴露出来；
    // 测试体要直接 yield 这几个服务，得单独列出来（同一 layer 引用由 memoMap 去重）。
    BackgroundJob.defaultLayer,
    SessionStatus.defaultLayer,
    SessionRunState.defaultLayer,
    Layer.succeed(BackgroundStore.directory, store),
  ),
)

describe("background.cancel", () => {
  // 261105 Red 审计 RC-015-01：job.ts 的 cancelTree 只结束 job，fiber 中断跑不到 processor
  // 收尾的 status.set(idle)。共用取消操作必须把被中断会话的 busy/retry 一起归位，
  // 否则 HTTP 后台面板取消后 TUI/GUI 的等待指示器会永久旋转（261023 实证）。
  it.instance("cancels the job tree and resets every cancelled session to idle", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const status = yield* SessionStatus.Service
      const cancel = yield* BackgroundCancel.Service
      const parent = SessionID.make("ses_bg_cancel_parent")
      const child = SessionID.make("ses_bg_cancel_child")

      yield* jobs.start({ id: parent, type: "task", run: Effect.never })
      yield* jobs.start({
        id: child,
        type: "task",
        metadata: { parentSessionId: parent },
        run: Effect.never,
      })
      yield* status.set(parent, { type: "busy" })
      yield* status.set(child, { type: "retry", attempt: 1, message: "provider quota exceeded", next: 0 })

      const cancelled = yield* cancel.cancelTree(parent)

      expect(cancelled.toSorted()).toEqual([child, parent].toSorted())
      expect((yield* jobs.get(parent))?.status).toBe("cancelled")
      expect((yield* jobs.get(child))?.status).toBe("cancelled")
      expect((yield* status.get(parent)).type).toBe("idle")
      expect((yield* status.get(child)).type).toBe("idle")
    }),
  )

  it.instance("is idempotent when the tree is already cancelled", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const status = yield* SessionStatus.Service
      const cancel = yield* BackgroundCancel.Service
      const parent = SessionID.make("ses_bg_cancel_repeat_parent")
      const child = SessionID.make("ses_bg_cancel_repeat_child")

      yield* jobs.start({ id: parent, type: "task", run: Effect.never })
      yield* jobs.start({
        id: child,
        type: "task",
        metadata: { parentSessionId: parent },
        run: Effect.never,
      })
      yield* status.set(child, { type: "busy" })

      expect((yield* cancel.cancelTree(parent)).toSorted()).toEqual([child, parent].toSorted())
      expect((yield* cancel.cancelTree(parent)).length).toBe(0)
      expect((yield* status.get(parent)).type).toBe("idle")
      expect((yield* status.get(child)).type).toBe("idle")
    }),
  )

  // 261107 Red 复刻线上形态：job 的取消只中断等 Deferred 的外壳 fiber，真正的模型循环
  // fork 在 SessionRunState 的 runner scope 里。取消必须落到 work fiber 上，否则后台
  // 面板显示「已取消」而子会话继续发请求写文件（线上 19:51 取消，19:57 仍在写）。
  it.instance("interrupts the session runner work fiber, not just the background job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const cancel = yield* BackgroundCancel.Service
      const session = SessionID.make("ses_bg_cancel_runner")
      const interrupted = yield* Deferred.make<void>()

      yield* jobs.start({
        id: session,
        type: "task",
        run: Effect.gen(function* () {
          yield* runState.ensureRunning(
            session,
            Effect.succeed(undefined as unknown as MessageV2.WithParts),
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid))),
          )
          return ""
        }),
      })
      yield* pollWithTimeout(
        Effect.succeed(runState.isBusy(session) ? true : undefined),
        "session runner never became busy",
      )

      yield* cancel.cancelTree(session)

      expect(yield* Deferred.isDone(interrupted)).toBe(true)
      expect(yield* runState.isBusy(session)).toBe(false)
    }),
  )
})
