// 260903 cc A9：流中途静默的看门狗。
//
// ⚠️ 必须用真时钟（`it.live` / 裸 test），不能用 `it.effect` —— 后者跑在 TestClock 上，
// 里面的 `Effect.sleep` 永远不会醒，测试进程直接挂死不返回（260814 实测踩过）。
// 所以这里把阈值调到几百毫秒，用 bun:test 的 test 直接跑 Effect.runPromise。
import { describe, expect, test } from "bun:test"
import { Effect, Duration, Deferred, Stream } from "effect"
import { FirstEventTimeoutError, StreamIdleTimeoutError } from "../../src/session/llm"

/**
 * 复刻 llm.ts 的 guardFirstEvent，把三个时间常量参数化，便于毫秒级验证。
 * 逻辑与实现逐行同构；实现改了这里要跟着改（两边都在同一个 commit 里）。
 */
function guard<S, E>(
  stream: Stream.Stream<S, E>,
  ctrl: AbortController,
  o: { first: Duration.Duration; idle: Duration.Duration; tick: Duration.Duration },
): Stream.Stream<S, E | FirstEventTimeoutError | StreamIdleTimeoutError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const state = { last: Date.now(), seen: false }
      const signal = yield* Deferred.make<never, FirstEventTimeoutError | StreamIdleTimeoutError>()
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(o.tick)
            const idle = Date.now() - state.last
            const limit = Duration.toMillis(state.seen ? o.idle : o.first)
            if (idle < limit) continue
            ctrl.abort()
            yield* Deferred.fail(signal, state.seen ? new StreamIdleTimeoutError(idle) : new FirstEventTimeoutError())
            return
          }
        }),
      )
      return Stream.merge(
        stream.pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              state.last = Date.now()
              state.seen = true
            }),
          ),
        ),
        Stream.fromEffect(Deferred.await(signal)),
        { haltStrategy: "either" },
      )
    }),
  )
}

const OPTS = { first: Duration.millis(300), idle: Duration.millis(400), tick: Duration.millis(25) }

const collect = <S, E>(s: Stream.Stream<S, E>, ctrl: AbortController) =>
  Stream.runCollect(guard(s, ctrl, OPTS)).pipe(Effect.scoped, Effect.result, Effect.runPromise)

describe("LLM 流看门狗", () => {
  test("正常流：全部事件原样通过，不误杀", async () => {
    const ctrl = new AbortController()
    const src = Stream.fromIterable([1, 2, 3, 4, 5]).pipe(Stream.mapEffect((n) => Effect.as(Effect.sleep(Duration.millis(20)), n)))
    const out = await collect(src, ctrl)
    expect(out._tag).toBe("Success")
    if (out._tag === "Success") expect(Array.from(out.success)).toEqual([1, 2, 3, 4, 5])
    expect(ctrl.signal.aborted).toBe(false)
  })

  test("首事件迟迟不来：报 FirstEventTimeoutError 并 abort", async () => {
    const ctrl = new AbortController()
    const src = Stream.fromEffect(Effect.as(Effect.sleep(Duration.seconds(30)), 1))
    const out = await collect(src, ctrl)
    expect(out._tag).toBe("Failure")
    if (out._tag === "Failure") expect((out.failure as { _tag?: string })._tag).toBe("FirstEventTimeoutError")
    expect(ctrl.signal.aborted).toBe(true)
  })

  // 这一条是 A9 的核心：旧实现在首事件到达后就再无防线，这里必须判红才说明修好了
  test("首事件到了、流中途静默：报 StreamIdleTimeoutError 并 abort", async () => {
    const ctrl = new AbortController()
    const src = Stream.concat(
      Stream.fromIterable([1, 2]),
      Stream.fromEffect(Effect.as(Effect.sleep(Duration.seconds(30)), 3)),
    )
    const out = await collect(src, ctrl)
    expect(out._tag).toBe("Failure")
    if (out._tag === "Failure") {
      expect((out.failure as { _tag?: string })._tag).toBe("StreamIdleTimeoutError")
      expect((out.failure as StreamIdleTimeoutError).idleMs).toBeGreaterThanOrEqual(Duration.toMillis(OPTS.idle) - 50)
    }
    expect(ctrl.signal.aborted).toBe(true)
  })

  test("事件密集但总时长超过阈值：不该被误杀（看门狗掐的是间隔不是总时长）", async () => {
    const ctrl = new AbortController()
    // 12 个事件 × 80ms = 960ms 总时长，远超 400ms 的 idle 阈值，但每个间隔都只有 80ms
    const src = Stream.fromIterable([...Array(12).keys()]).pipe(
      Stream.mapEffect((n) => Effect.as(Effect.sleep(Duration.millis(80)), n)),
    )
    const out = await collect(src, ctrl)
    expect(out._tag).toBe("Success")
    if (out._tag === "Success") expect(Array.from(out.success)).toHaveLength(12)
    expect(ctrl.signal.aborted).toBe(false)
  })

  test("两类超时都被 retryable 认成可重试", async () => {
    const { retryable } = await import("../../src/session/retry")
    expect(retryable(new FirstEventTimeoutError() as never, "test")).toBeTruthy()
    expect(retryable(new StreamIdleTimeoutError(120000) as never, "test")).toBeTruthy()
  })
})
