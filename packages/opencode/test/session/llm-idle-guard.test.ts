// 260903 cc A9：流中途静默的看门狗。
//
// ⚠️ 必须用真时钟（`it.live` / 裸 test），不能用 `it.effect` —— 后者跑在 TestClock 上，
// 里面的 `Effect.sleep` 永远不会醒，测试进程直接挂死不返回（260814 实测踩过）。
// 所以这里把阈值调到几百毫秒，用 bun:test 的 test 直接跑 Effect.runPromise。
//
// 260916 Red 改为直接调用 llm.ts 的真实现（guardFirstEvent 已导出、三个阈值可注入）。
// 此前这里是"逐行复刻"的一份 shadow 实现，而 260916 的并行工具误杀恰恰因为复刻版没
// 跟上实现（复刻版从来没有 local 逻辑）而在测试里隐形——复刻即漂移源，不再复刻。
import { describe, expect, test } from "bun:test"
import { Effect, Duration, Stream } from "effect"
import { FirstEventTimeoutError, StreamIdleTimeoutError, guardFirstEvent } from "../../src/session/llm"

const OPTS = { first: Duration.millis(300), idle: Duration.millis(400), tick: Duration.millis(25) }

const collect = <S, E>(s: Stream.Stream<S, E>, ctrl: AbortController) =>
  Stream.runCollect(guardFirstEvent(s, ctrl, OPTS)).pipe(Effect.scoped, Effect.result, Effect.runPromise)

// 看门狗读的是 event.type / event.id（真实现里对 LLMEvent 的宽松访问），这里用同形状喂它
type Ev = { type: string; id: string; output?: string }

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

  // 260916 Red 并行工具：一个 step 里可以同时发出多个 tool-call，各自的 tool-result
  // 陆续返回。修前实现用单个 local 布尔表示"本地在干活"——快工具先生就把本地态清掉，
  // 慢工具（或"等用户点权限"）还在跑时看门狗恢复计时，120 秒后误杀整轮。
  // 实测 260915 两次 StreamIdleTimeoutError：同一条消息里 read / 快 bash 都已 completed，
  // 慢的 `redcode doctor --json`（timeout 180000）被 abort，state.error 记
  // "Tool execution aborted"。判据必须是"还有工具没回来"（在途集合非空），不是布尔。
  test("并行工具：快工具已返回、慢工具仍在跑时，不该被误杀", async () => {
    const ctrl = new AbortController()
    const head: Ev[] = [
      { type: "tool-call", id: "fast" },
      { type: "tool-call", id: "slow" },
      { type: "tool-result", id: "fast", output: "ok" },
    ]
    const src = Stream.concat(
      Stream.fromIterable(head),
      // 慢工具还在执行：这段静默（700ms）远超 idle 阈值（400ms）
      Stream.fromEffect(Effect.as(Effect.sleep(Duration.millis(700)), { type: "tool-result", id: "slow", output: "ok" })),
    )
    const out = await collect(src, ctrl)
    expect(out._tag).toBe("Success")
    if (out._tag === "Success") expect(Array.from(out.success)).toHaveLength(4)
    expect(ctrl.signal.aborted).toBe(false)
  })

  // 反向：工具全部结束后网关真的静默，看门狗必须仍然开火（别把豁免做成了永久免疫）
  test("工具全部结束后网关静默：仍报 StreamIdleTimeoutError", async () => {
    const ctrl = new AbortController()
    const head: Ev[] = [
      { type: "tool-call", id: "a" },
      { type: "tool-call", id: "b" },
      { type: "tool-result", id: "a" },
      { type: "tool-result", id: "b" },
    ]
    const src = Stream.concat(
      Stream.fromIterable(head),
      Stream.fromEffect(Effect.as(Effect.sleep(Duration.seconds(30)), { type: "tool-result", id: "c" })),
    )
    const out = await collect(src, ctrl)
    expect(out._tag).toBe("Failure")
    if (out._tag === "Failure") expect((out.failure as { _tag?: string })._tag).toBe("StreamIdleTimeoutError")
    expect(ctrl.signal.aborted).toBe(true)
  })

  test("两类超时都被 retryable 认成可重试", async () => {
    const { retryable } = await import("../../src/session/retry")
    expect(retryable(new FirstEventTimeoutError() as never, "test")).toBeTruthy()
    expect(retryable(new StreamIdleTimeoutError(120000) as never, "test")).toBeTruthy()
  })

  // 260916 Red 看门狗必须随自己的流一起结束。真实事故：explore 子代理 05:36:58 创建的
  // 一个 guard 实例活到 05:39:04（125 秒）才开火，`idle` 精确落回创建时刻，掐掉了当时
  // 正在正常推进的 step 31（会话日志：两条 Aborted + 一条 StreamIdleTimeoutError 都挂在
  // step 31 的 messageID 下）。主流走完后若看门狗 fiber 仍在，就会对"已经换了一轮"的
  // 请求开火——这条用例钉住它必须停。
  test("主流正常走完后：看门狗必须停止，不越过自己的流去开火", async () => {
    const ctrl = new AbortController()
    const src = Stream.fromIterable([1, 2, 3]).pipe(
      Stream.mapEffect((n) => Effect.as(Effect.sleep(Duration.millis(20)), n)),
    )
    const out = await collect(src, ctrl)
    expect(out._tag).toBe("Success")
    // 等远超 idle 阈值（400ms）：看门狗若还活着，就会在这里 abort
    await new Promise((resolve) => setTimeout(resolve, Duration.toMillis(OPTS.idle) * 2))
    expect(ctrl.signal.aborted).toBe(false)
  })

  // 260916 Red 还原 llm.ts:383 的真实结构：那边是
  //   Stream.scoped(Stream.unwrap(Effect.gen(function* () { ...guardFirstEvent(...) })))
  // 不是裸 guard。这一层 scoped 决定 ctrl / 看门狗 fiber 的生命周期挂在哪儿——
  // 上面那条用例已证明裸 guard 会随流正确停止，这里看这层包装会不会改变结论。
  test("Stream.scoped 包裹（还原 llm.stream 结构）：流结束后看门狗仍须停止", async () => {
    const ctrl = new AbortController()
    const src = Stream.fromIterable([1, 2, 3]).pipe(
      Stream.mapEffect((n) => Effect.as(Effect.sleep(Duration.millis(20)), n)),
    )
    const out = await Stream.runCollect(Stream.scoped(guardFirstEvent(src, ctrl, OPTS)))
      .pipe(Effect.scoped, Effect.result, Effect.runPromise)
    expect(out._tag).toBe("Success")
    await new Promise((resolve) => setTimeout(resolve, Duration.toMillis(OPTS.idle) * 2))
    expect(ctrl.signal.aborted).toBe(false)
  })
})
