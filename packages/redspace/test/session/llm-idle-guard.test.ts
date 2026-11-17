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
import { Effect, Duration, Logger, Stream } from "effect"
import {
  FirstEventTimeoutError,
  StreamIdleTimeoutError,
  ToolInputGuardError,
  guardFirstEvent,
} from "../../src/session/llm"

const OPTS = { first: Duration.millis(300), idle: Duration.millis(400), tick: Duration.millis(25) }

const collect = <S, E>(s: Stream.Stream<S, E>, ctrl: AbortController) =>
  Stream.runCollect(guardFirstEvent(s, ctrl, OPTS)).pipe(Effect.scoped, Effect.result, Effect.runPromise)

// 看门狗读的是 event.type / event.id（真实现里对 LLMEvent 的宽松访问），这里用同形状喂它
type Ev = { type: string; id: string; output?: string }

describe("LLM 流看门狗", () => {
  test("长时间生成工具参数时记录计数进度，不记录参数正文", async () => {
    const ctrl = new AbortController()
    const logs: string[] = []
    const secret = "private-summary-fragment"
    const events = [
      { type: "tool-input-start", id: "call-1", name: "compress" },
      ...Array.from({ length: 12 }, () => ({ type: "tool-input-delta", id: "call-1", text: secret })),
      { type: "tool-call", id: "call-1" },
      { type: "tool-result", id: "call-1" },
    ]
    const src = Stream.fromIterable(events).pipe(
      Stream.mapEffect((event) => Effect.as(Effect.sleep(Duration.millis(70)), event)),
    )
    const out = await Stream.runCollect(guardFirstEvent(src, ctrl, OPTS)).pipe(
      Effect.scoped,
      Effect.result,
      Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(JSON.stringify(message)))])),
      Effect.runPromise,
    )

    expect(out._tag).toBe("Success")
    expect(logs.some((entry) => entry.includes("llm.tool-input progress"))).toBe(true)
    expect(logs.some((entry) => entry.includes("llm.tool-input complete"))).toBe(true)
    expect(logs.join(" ")).not.toContain(secret)
    expect(ctrl.signal.aborted).toBe(false)
  })

  test("工具参数未生成完就断流时留下可区分的收尾记录", async () => {
    const ctrl = new AbortController()
    const logs: string[] = []
    const src = Stream.concat(
      Stream.fromIterable([
        { type: "tool-input-start", id: "call-1", name: "compress" },
        { type: "tool-input-delta", id: "call-1", text: "private-fragment" },
      ]),
      Stream.fromEffect(Effect.as(Effect.sleep(Duration.seconds(30)), { type: "tool-input-end", id: "call-1" })),
    )
    const out = await Stream.runCollect(guardFirstEvent(src, ctrl, OPTS)).pipe(
      Effect.scoped,
      Effect.result,
      Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(JSON.stringify(message)))])),
      Effect.runPromise,
    )

    expect(out._tag).toBe("Failure")
    expect(logs.some((entry) => entry.includes("llm.tool-input unfinished"))).toBe(true)
    expect(logs.join(" ")).not.toContain("private-fragment")
    expect(ctrl.signal.aborted).toBe(true)
  })

  test("正常流：全部事件原样通过，不误杀", async () => {
    const ctrl = new AbortController()
    const src = Stream.fromIterable([1, 2, 3, 4, 5]).pipe(
      Stream.mapEffect((n) => Effect.as(Effect.sleep(Duration.millis(20)), n)),
    )
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
      Stream.fromEffect(
        Effect.as(Effect.sleep(Duration.millis(700)), { type: "tool-result", id: "slow", output: "ok" }),
      ),
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

  // 261021 Red 纯思考静默的裁决权在外层 reasoningStall 兜底（processor 的
  // Stream.timeoutOrElse → promoteReasoning 收尾），本层 idle 不开火——否则 120s 先到
  // 走重试链把请求重发、思考全丢，外层兜底成死配置。
  test("纯思考后静默：不属本层 idle 管辖，不开火", async () => {
    const ctrl = new AbortController()
    const src = Stream.concat(
      Stream.fromIterable([
        { type: "reasoning-start", id: "r-0" },
        { type: "reasoning-delta", id: "r-0", text: "thinking" },
      ]),
      // 静默 700ms 远超 idle 阈值（400ms）：纯思考阶段豁免
      Stream.fromEffect(Effect.as(Effect.sleep(Duration.millis(700)), { type: "reasoning-end", id: "r-0" })),
    )
    const out = await collect(src, ctrl)
    expect(out._tag).toBe("Success")
    expect(ctrl.signal.aborted).toBe(false)
  })

  // 反向：正文产出之后再静默，本层 idle 恢复计时（豁免不是永久免疫）
  test("正文产出后网关静默：恢复 idle 计时并开火", async () => {
    const ctrl = new AbortController()
    const src = Stream.concat(
      Stream.fromIterable([
        { type: "reasoning-start", id: "r-0" },
        { type: "reasoning-delta", id: "r-0", text: "thinking" },
        { type: "text-delta", id: "t-0", text: "answer" },
      ]),
      Stream.fromEffect(Effect.as(Effect.sleep(Duration.seconds(30)), { type: "text-end", id: "t-0" })),
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

  test("新 input start 不会刷新旧 input 的 idle 时间", async () => {
    const ctrl = new AbortController()
    const src = Stream.concat(
      Stream.fromIterable([{ type: "tool-input-start", id: "old", name: "grep" }]),
      Stream.fromIterable(Array.from({ length: 20 }, (_, index) => index)).pipe(
        Stream.mapEffect((index) =>
          Effect.as(Effect.sleep(Duration.millis(20)), { type: "tool-input-start", id: `new-${index}`, name: "read" }),
        ),
      ),
    )
    const out = await Stream.runCollect(
      guardFirstEvent(src, ctrl, OPTS, { toolInput: { idleMs: 100, maxPendingCalls: 64 } }),
    ).pipe(Effect.scoped, Effect.result, Effect.runPromise)
    expect(out._tag).toBe("Failure")
    if (out._tag === "Failure") expect((out.failure as { _tag?: string })._tag).toBe("ToolInputGuardError")
    expect(ctrl.signal.aborted).toBe(true)
  })

  test("超过 pending input 预算失败且错误不自动重试", async () => {
    const ctrl = new AbortController()
    const src = Stream.fromIterable([
      { type: "tool-input-start", id: "1", name: "grep" },
      { type: "tool-input-start", id: "2", name: "read" },
      { type: "tool-input-start", id: "3", name: "write" },
    ])
    const out = await Stream.runCollect(
      guardFirstEvent(src, ctrl, OPTS, { toolInput: { idleMs: 100, maxPendingCalls: 2 } }),
    ).pipe(Effect.scoped, Effect.result, Effect.runPromise)
    expect(out._tag).toBe("Failure")
    if (out._tag === "Failure") expect((out.failure as { _tag?: string })._tag).toBe("ToolInputGuardError")
    expect(ctrl.signal.aborted).toBe(true)
    const { retryable } = await import("../../src/session/retry")
    expect(retryable(new ToolInputGuardError("budget", "3", "write", 3, 2, 0), "test")).toBeUndefined()
    expect(retryable(new ToolInputGuardError("idle", "1", "grep", 1, 1000, 1000), "test")).toBeUndefined()
  })

  test("密集的 1000 个 start 在超预算点停止消费和下传", async () => {
    const ctrl = new AbortController()
    const consumed: string[] = []
    const forwarded: string[] = []
    const src = Stream.fromIterable(
      Array.from({ length: 1000 }, (_, index) => ({
        type: "tool-input-start",
        id: `call-${index}`,
        name: "grep",
      })),
    ).pipe(Stream.tap((event) => Effect.sync(() => consumed.push(event.id))))
    const out = await Stream.runCollect(
      guardFirstEvent(src, ctrl, OPTS, { toolInput: { idleMs: 100, maxPendingCalls: 2 } }).pipe(
        Stream.tap((event) => Effect.sync(() => forwarded.push(event.id))),
      ),
    ).pipe(Effect.scoped, Effect.result, Effect.runPromise)
    expect(out._tag).toBe("Failure")
    expect(consumed.length).toBe(3)
    expect(forwarded.length).toBe(2)
    expect(ctrl.signal.aborted).toBe(true)
  })

  test("同 id 重复 start 去重，并行输入和持续参数进展正常完成", async () => {
    const ctrl = new AbortController()
    const events = [
      { type: "tool-input-start", id: "one", name: "grep" },
      { type: "tool-input-start", id: "one", name: "grep" },
      { type: "tool-input-start", id: "two", name: "read" },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: "tool-input-delta",
        id: index % 2 === 0 ? "one" : "two",
        text: "x",
      })),
      { type: "tool-call", id: "one" },
      { type: "tool-call", id: "two" },
      { type: "tool-result", id: "one" },
      { type: "tool-result", id: "two" },
    ]
    const src = Stream.fromIterable(events).pipe(
      Stream.mapEffect((event) =>
        Effect.as(Effect.sleep(event.type === "tool-input-delta" ? Duration.millis(50) : Duration.zero), event),
      ),
    )
    const out = await Stream.runCollect(
      guardFirstEvent(src, ctrl, OPTS, { toolInput: { idleMs: 150, maxPendingCalls: 2 } }),
    ).pipe(Effect.scoped, Effect.result, Effect.runPromise)
    expect(out._tag).toBe("Success")
    expect(ctrl.signal.aborted).toBe(false)
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
    const out = await Stream.runCollect(Stream.scoped(guardFirstEvent(src, ctrl, OPTS))).pipe(
      Effect.scoped,
      Effect.result,
      Effect.runPromise,
    )
    expect(out._tag).toBe("Success")
    await new Promise((resolve) => setTimeout(resolve, Duration.toMillis(OPTS.idle) * 2))
    expect(ctrl.signal.aborted).toBe(false)
  })
})
