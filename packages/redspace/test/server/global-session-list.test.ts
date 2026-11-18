import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { inArray } from "drizzle-orm"
import { Project } from "@/project/project"
import { Session as SessionNs } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import * as Log from "@redcode-ai/core/util/log"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Project.defaultLayer, CrossSpawnSpawner.defaultLayer))

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

describe("session.listGlobal", () => {
  it.instance(
    "lists sessions across projects with project metadata",
    () =>
      Effect.gen(function* () {
        const first = yield* TestInstance
        const second = yield* tmpdirScoped({ git: true })

        const firstSession = yield* withSession({ title: "first-session" })
        const secondSession = yield* withSession({ title: "second-session" }).pipe(provideInstance(second))

        const sessions = yield* Effect.sync(() => [...SessionNs.listGlobal({ limit: 200 })])
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(firstSession.id)
        expect(ids).toContain(secondSession.id)

        const firstProject = yield* Project.use.get(firstSession.projectID)
        const secondProject = yield* Project.use.get(secondSession.projectID)

        const firstItem = sessions.find((session) => session.id === firstSession.id)
        const secondItem = sessions.find((session) => session.id === secondSession.id)

        expect(firstItem?.project?.id).toBe(firstProject?.id)
        expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
        expect(secondItem?.project?.id).toBe(secondProject?.id)
        expect(secondItem?.project?.worktree).toBe(secondProject?.worktree)
        expect(first.directory).not.toBe(second)
      }),
    { git: true },
  )

  it.instance(
    "excludes archived sessions by default",
    () =>
      Effect.gen(function* () {
        const archived = yield* withSession({ title: "archived-session" })

        yield* SessionNs.Service.use((session) => session.setArchived({ sessionID: archived.id, time: Date.now() }))

        const sessions = yield* Effect.sync(() => [...SessionNs.listGlobal({ limit: 200 })])
        const ids = sessions.map((session) => session.id)

        expect(ids).not.toContain(archived.id)

        const allSessions = yield* Effect.sync(() => [...SessionNs.listGlobal({ limit: 200, archived: true })])
        const allIds = allSessions.map((session) => session.id)

        expect(allIds).toContain(archived.id)
      }),
    { git: true },
  )

  // 260814 Red 取消归档：setArchived 传 null 清掉时间戳，会话回到默认列表。
  // 归档此前是单向的（HTTP payload 只能传数字、服务层签名不收 null），这条守住往返闭环。
  it.instance(
    "restores an archived session when archived time is cleared",
    () =>
      Effect.gen(function* () {
        const session = yield* withSession({ title: "unarchive-session" })

        yield* SessionNs.Service.use((s) => s.setArchived({ sessionID: session.id, time: Date.now() }))
        const hidden = yield* Effect.sync(() => [...SessionNs.listGlobal({ limit: 200 })])
        expect(hidden.map((s) => s.id)).not.toContain(session.id)

        yield* SessionNs.Service.use((s) => s.setArchived({ sessionID: session.id, time: null }))

        const visible = yield* Effect.sync(() => [...SessionNs.listGlobal({ limit: 200 })])
        expect(visible.map((s) => s.id)).toContain(session.id)

        const restored = yield* SessionNs.Service.use((s) => s.get(session.id))
        expect(restored.time.archived).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "supports cursor pagination",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const first = yield* withSession({ title: "page-one" })
        const ready = yield* Deferred.make<void>()
        yield* Deferred.succeed(ready, undefined).pipe(Effect.delay("5 millis"), Effect.forkScoped)
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting between session creates")),
          }),
        )
        const second = yield* withSession({ title: "page-two" })

        const page = yield* Effect.sync(() => [...SessionNs.listGlobal({ directory: test.directory, limit: 1 })])
        expect(page.length).toBe(1)
        expect(page[0].id).toBe(second.id)

        const next = yield* Effect.sync(() => [
          ...SessionNs.listGlobal({ directory: test.directory, limit: 10, cursor: page[0].time.updated }),
        ])
        const ids = next.map((session) => session.id)

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      }),
    { git: true },
  )

  // 261118 Red 同毫秒跨页：排序键是 (time_updated DESC, id DESC)，只带时间的游标会让
  // 时间相等的行在下一页被整批跳过。create() 用真实时钟，同毫秒不可靠复现，所以这里
  // 直接把三行钉到同一个 time_updated——这是刻意构造的存储状态，不是运行时行为。
  it.instance(
    "pages same-millisecond sessions without dropping rows",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const a = yield* withSession({ title: "same-ms-a" })
        const b = yield* withSession({ title: "same-ms-b" })
        const c = yield* withSession({ title: "same-ms-c" })

        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(SessionTable)
              .set({ time_updated: 1_700_000_000_000 })
              .where(inArray(SessionTable.id, [a.id, b.id, c.id]))
              .run(),
          ),
        )

        const all = yield* Effect.sync(() => [...SessionNs.listGlobal({ directory: test.directory, limit: 10 })])
        expect(all.map((session) => session.id).sort()).toEqual([a.id, b.id, c.id].sort())

        const first = yield* Effect.sync(() => [...SessionNs.listGlobal({ directory: test.directory, limit: 2 })])
        expect(first.length).toBe(2)

        const cursor = SessionNs.listCursor(first[first.length - 1]!)
        const next = yield* Effect.sync(() => [
          ...SessionNs.listGlobal({ directory: test.directory, limit: 2, cursor }),
        ])
        // 核心断言：复合游标翻完两页不重不漏（旧游标这一页会是空数组）。
        const paged = [...first, ...next].map((session) => session.id)
        expect(new Set(paged).size).toBe(3)

        // 旧客户端只发时间戳：保持原语义（同毫秒行不进入下一页），兼容路径不静默升级。
        const legacy = yield* Effect.sync(() => [
          ...SessionNs.listGlobal({ directory: test.directory, limit: 2, cursor: first[1]!.time.updated }),
        ])
        expect(legacy).toHaveLength(0)
      }),
    { git: true },
  )
})
