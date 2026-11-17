// 261011 Red B1.1（审计 ZW-09 / §9）：provider 状态初始化步级死线的行为契约——
// 先测已加死线的实际效果（10s 超时跳过 + 流程恢复），确认行为后再评估是否需要
// 更大改动（补取消等）。
//
// 背景：models.dev / 插件 models·auth 钩子 / 自定义 loader / gitlab discovery 被
// 代理卡死时，一个挂起的调用会让该目录的 provider 状态永远初始化不完，
// /config/providers 全排队到客户端 60s deadline 被 499 切断（261011 启动事故）。
// withinInitStep 给每个调用点 10s 小死线：超时跳过该步（warn + undefined，调用点
// 按 undefined 走回退，如 plugin models hook 的 `hooked ?? provider.models`），
// 其余 provider 照常可用。TestClock 拨表免真等。
import { describe, expect } from "bun:test"
import { Duration, Effect, Exit, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { withinInitStep } from "@/provider/provider"
import { it } from "../lib/effect"

describe("provider init 步级死线（withinInitStep）", () => {
  it.effect("挂起步骤 10s 后被跳过（undefined），后续步骤照常", () =>
    Effect.gen(function* () {
      const hanging = yield* Effect.forkChild(withinInitStep("test-hang")(Effect.never))
      yield* TestClock.adjust(Duration.seconds(11))
      expect(yield* Fiber.join(hanging)).toBeUndefined()
      // 同一作用域内后续步骤不受影响（恢复）：
      expect(yield* withinInitStep("test-after")(Effect.succeed("ok"))).toBe("ok")
    }),
  )

  it.effect("死线内正常完成：原值透传", () =>
    Effect.gen(function* () {
      const slow = yield* Effect.forkChild(
        withinInitStep("test-slow")(Effect.sleep(Duration.seconds(5)).pipe(Effect.as(42))),
      )
      yield* TestClock.adjust(Duration.seconds(6))
      expect(yield* Fiber.join(slow)).toBe(42)
    }),
  )

  it.effect("非超时失败原样传播（死线只吃 TimeoutError，不吞其它错误）", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(withinInitStep("test-fail")(Effect.fail(new Error("boom"))))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
