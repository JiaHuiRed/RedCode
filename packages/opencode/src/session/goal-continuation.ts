import { Context, Effect, Layer, Option, Scope, Stream } from "effect"

import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Goal } from "./goal"
import { Session } from "./session"
import { SessionPrompt } from "./prompt"
import { SessionStatus } from "./status"
import { MessageID, SessionID } from "./schema"

// 260801 Red Goal 自动续跑（experimental.goal_auto_continue 开启时生效，默认关）
// 防跑飞三闸门：轮次上限 / 时间闸 / 用户插话停。全部通过才注入 synthetic steering 并续跑。
const MAX_GOAL_TURNS = 20 // 260801 Red 一次钉目标最多自动续跑 20 轮
const MIN_CONTINUE_INTERVAL_MS = 30_000 // 260801 Red 距上次续跑至少 30s
const DEFAULT_TOKEN_BUDGET = 200_000 // 260801 Red 未配置 goal_token_budget 时的默认预算

const steering = (text: string) =>
  `[自动续跑] 会话空闲，但你仍钉着目标：<goal>${text}</goal>。请继续推进这个目标；若已完成，调用 goal_done 结束；若目标有变，调用 goal_set 更新。`

const budgetFinish = (budget: number) =>
  `[自动续跑] 目标 token 预算已用尽（${budget} tokens），goal 已标记 budget_limited。请总结当前进度与剩余工作，然后调用 goal_clear 或给用户一个收尾回复。`

export interface Interface {
  readonly maybeContinue: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GoalContinuation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const ops = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    // 260801 Red 每 session 上次注入的 steering 消息 id + 上次续跑时间（内存态，重启即失）
    const lastSteer = new Map<SessionID, MessageID>()
    const lastRunAt = new Map<SessionID, number>()

    const maybeContinue = Effect.fn("GoalContinuation.maybeContinue")(function* (sessionID: SessionID) {
      // 1. 开关（默认关，哥哥拍板）。配置损坏时按关处理，不让 DecodeError 崩订阅
      const cfg = yield* config.get().pipe(Effect.catch(() => Effect.succeed({} as Config.Info)))
      if (cfg.experimental?.goal_auto_continue !== true) return

      // 2. goal 必须 active
      const g = yield* goal.get(sessionID)
      if (!g || g.status !== "active") return

      // 3. 轮次上限
      if (g.turn_count >= MAX_GOAL_TURNS) return

      // 4. 时间闸：距上次续跑不足 30s 不跑（避免紧贴 idle 连发）
      const now = Date.now()
      const last = lastRunAt.get(sessionID)
      if (last !== undefined && now - last < MIN_CONTINUE_INTERVAL_MS) return

      // 5. token 预算：超限注入收尾 prompt + mark budget_limited（一次后 status 非 active，自动停）
      const budget = cfg.experimental?.goal_token_budget ?? DEFAULT_TOKEN_BUDGET
      if (g.tokens_used >= budget) {
        const agent = (yield* sessions.get(sessionID).pipe(Effect.orDie)).agent ?? "build"
        const message = yield* ops.prompt({
          sessionID,
          noReply: true,
          agent,
          parts: [{ type: "text", synthetic: true, text: budgetFinish(budget) }],
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (message === undefined) return // 260801 Red 注入失败（Image.Error 等）跳过本次续跑
        lastSteer.set(sessionID, message.info.id)
        yield* goal.mark(sessionID, "budget_limited")
        yield* goal.mark(sessionID, "budget_limited")
        yield* bus.publish(TuiEvent.ToastShow, {
          title: "目标预算用尽",
          message: "goal 已标记 budget_limited",
          variant: "warning",
          duration: 5000,
        })
        yield* ops.loop({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        return
      }

      // 6. 用户插话检查：最新 user 消息不是我们注入的那条就停
      const latest = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user").pipe(Effect.orDie)
      if (Option.isNone(latest)) return
      const prev = lastSteer.get(sessionID)
      if (prev !== undefined && latest.value.info.id !== prev) return

      // 7. 注入 steering + 记录 + tick + 续跑
      lastRunAt.set(sessionID, now)
      const agent = (yield* sessions.get(sessionID).pipe(Effect.orDie)).agent ?? "build"
      const message = yield* ops.prompt({
        sessionID,
        noReply: true,
        agent,
        parts: [{ type: "text", synthetic: true, text: steering(g.text) }],
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (message === undefined) return // 260801 Red 注入失败（Image.Error 等）跳过本次续跑
      lastSteer.set(sessionID, message.info.id)
      yield* goal.tick(sessionID)
      yield* goal.tick(sessionID)
      yield* bus.publish(TuiEvent.ToastShow, {
        title: "目标自动续跑",
        message: g.text.length > 40 ? `${g.text.slice(0, 40)}…` : g.text,
        variant: "info",
        duration: 3000,
      })
      yield* ops.loop({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
    })

    // 260801 Red 订阅 idle 事件：runLoop 完成/取消/出错后触发（run-state onIdle + processor 错误路径都会发）
    yield* (yield* bus.subscribe(SessionStatus.Event.Idle)).pipe(
      Stream.tap(({ properties }) => maybeContinue(properties.sessionID).pipe(Effect.ignore)),
      Stream.runDrain,
      Effect.forkScoped,
    )

    return Service.of({ maybeContinue })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Goal.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
)

export * as GoalContinuation from "./goal-continuation"
