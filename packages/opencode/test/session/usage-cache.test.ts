import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Session as SessionNs } from "@/session/session"
import * as SessionUsage from "@/session/usage"
import { InstanceState } from "@/effect/instance-state"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, type SessionID } from "@/session/schema"
import * as Log from "@redcode-ai/core/util/log"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(SessionNs.defaultLayer)

// 260904 cc 用量聚合的指纹短路（黄档 A2）。
//
// 五个聚合查询各把同一批 message 行扫一遍，每条都要读 `message.data`——本机副本实测该列
// 合计 171MB，光读出来就 1462ms，整套冷态 2766ms / 热态 1307ms。指纹只数行数与最大时间戳、
// 不碰 data，热态中位 5.55ms：用 5ms 决定那 1.3s 要不要做。
//
// 命中与否用**返回对象的引用**判定：命中返回同一个对象，重算必然是新对象。

const assistant = Effect.fn("Test.assistant")(function* (sessionID: SessionID, created: number, output: number) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created, completed: created + 10 },
    agent: "test",
    mode: "",
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: "/", root: "/" },
    cost: 1,
    tokens: { input: 10, output, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } },
  } as unknown as MessageV2.Info)
  return id
})

const withSession = <A, E, R>(fn: (sessionID: SessionID) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      return (yield* session.create({})).id
    }),
    fn,
    (sessionID) =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        yield* session.remove(sessionID).pipe(Effect.ignore)
      }),
  )

const projectID = Effect.gen(function* () {
  return (yield* InstanceState.context).project.id
})

describe("SessionUsage.aggregate 指纹短路", () => {
  it.instance("同一指纹下第二次调用直接复用上一次的结果", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        const project = yield* projectID
        SessionUsage.invalidate()
        yield* assistant(sessionID, Date.now(), 100)

        const first = SessionUsage.aggregate({ projectID: project, range: "all", now: Date.now() })
        const second = SessionUsage.aggregate({ projectID: project, range: "all", now: Date.now() })

        // 同一个对象引用 = 没有重算
        expect(second).toBe(first)
        expect(first.tokens.output).toBe(100)
      }),
    ),
  )

  it.instance("来了新消息，指纹变了就重算", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        const project = yield* projectID
        SessionUsage.invalidate()
        yield* assistant(sessionID, Date.now(), 100)
        const before = SessionUsage.aggregate({ projectID: project, range: "all", now: Date.now() })

        yield* assistant(sessionID, Date.now() + 1, 40)
        const after = SessionUsage.aggregate({ projectID: project, range: "all", now: Date.now() })

        expect(after).not.toBe(before)
        expect(before.tokens.output).toBe(100)
        expect(after.tokens.output).toBe(140)
      }),
    ),
  )

  // 7d/30d 的窗口是**相对当前时间滑动**的：message 一行没变、时间往前走结果照样该变，
  // 指纹管不住这一维，所以这两档刻意不进缓存。
  it.instance("带时间窗的档位不走缓存", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        const project = yield* projectID
        SessionUsage.invalidate()
        yield* assistant(sessionID, Date.now(), 100)

        const first = SessionUsage.aggregate({ projectID: project, range: "7d", now: Date.now() })
        const second = SessionUsage.aggregate({ projectID: project, range: "7d", now: Date.now() })

        expect(second).not.toBe(first)
        expect(second).toEqual(first)
      }),
    ),
  )

  it.instance("invalidate 之后强制重算", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        const project = yield* projectID
        SessionUsage.invalidate()
        yield* assistant(sessionID, Date.now(), 100)

        const first = SessionUsage.aggregate({ projectID: project, range: "all", now: Date.now() })
        SessionUsage.invalidate(project)
        const second = SessionUsage.aggregate({ projectID: project, range: "all", now: Date.now() })

        expect(second).not.toBe(first)
        expect(second).toEqual(first)
      }),
    ),
  )
})
