import { describe, expect, test } from "bun:test"
import type { Message } from "@redcode-ai/sdk/v2/client"
import { getSessionContextMetrics } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContextMetrics", () => {
  test("total 是会话累计；usage 用最后一条的 tokens.context 算窗口占用率", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.totalCost).toBe(1.75)
    expect(metrics.context?.message.id).toBe("a2")
    expect(metrics.context?.total).toBe(500) // 累计：两条 assistant 的各项之和
    // 260819 cc 这里原来断言 usage===50，即 total(500)/limit(1000)——那是「会话累计 / 窗口」，
    // 长会话下会到几百上千 %。现在 usage 只认最后一条的 tokens.context；本用例的 fixture
    // 没有该字段，所以是 null（UI 侧整块不显示，等下一轮请求写入）。
    expect(metrics.context?.window).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
    expect(metrics.context?.providerLabel).toBe("OpenAI")
    expect(metrics.context?.modelLabel).toBe("GPT-4.1")
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.providerLabel).toBe("p-1")
    expect(metrics.context?.modelLabel).toBe("m-1")
    expect(metrics.context?.limit).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContextMetrics(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContextMetrics(messages, providers)

    expect(one.context?.message.id).toBe("a1")
    expect(two.context?.message.id).toBe("a2")
    expect(two.totalCost).toBe(1)
  })

  test("returns empty metrics when inputs are undefined", () => {
    const metrics = getSessionContextMetrics(undefined, undefined)

    expect(metrics.totalCost).toBe(0)
    expect(metrics.context).toBeUndefined()
  })
})

// 260819 cc audit：usage 原来是「会话累计 / 窗口」，长会话下能到 1500%，而 ProgressCircle
// 内部钳到 [0,100]，那个圈从超过一个窗口起就永远是满的。改用 tokens.context。
describe("上下文窗口口径", () => {
  const withContext = (id: string, ctx: number | undefined, read: number) =>
    ({
      id,
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-4.1",
      cost: 0,
      tokens: {
        input: 1_000,
        output: 500,
        reasoning: 0,
        ...(ctx === undefined ? {} : { context: ctx }),
        cache: { read, write: 0 },
      },
      time: { created: 1 },
    }) as unknown as Message

  const providers = [{ id: "openai", models: { "gpt-4.1": { limit: { context: 100_000 } } } }] as any[]

  test("usage 用最后一条的 tokens.context，不随会话累计涨", () => {
    // 三轮累计远超窗口（每轮 input+output+read = 41.5k，三轮 124.5k > 100k），
    // 但每一刻真实上下文只有 40k
    const msgs = [withContext("a", 40_000, 40_000), withContext("b", 40_000, 40_000), withContext("c", 40_000, 40_000)]
    const m = getSessionContextMetrics(msgs, providers).context!
    expect(m.window).toBe(40_000)
    expect(m.usage).toBe(40) // 修复前是 (124500/100000)*100 = 125
    expect(m.total).toBeGreaterThan(100_000) // total 仍是累计，标签本来就对，不动
  })

  test("历史消息没有 tokens.context 时 window/usage 都为空（UI 侧不显示）", () => {
    const m = getSessionContextMetrics([withContext("a", undefined, 10_000)], providers).context!
    expect(m.window).toBeUndefined()
    expect(m.usage).toBeNull()
  })

  // 260819 cc 档位由服务端算好随消息发来，metrics 只负责透传（GUI 的圈按它着色，纯装饰）
  test("level 透传自最后一条 assistant 的 contextLevel", () => {
    const withLevel = { ...(withContext("a", 40_000, 10_000) as any), contextLevel: "prune" }
    expect(getSessionContextMetrics([withLevel], providers).context!.level).toBe("prune")
  })

  test("历史消息没有 contextLevel 时 level 为空（圈保持默认色）", () => {
    expect(getSessionContextMetrics([withContext("a", 40_000, 10_000)], providers).context!.level).toBeUndefined()
  })

  test("窗口数缺失时 usage 为空但 window 仍给出", () => {
    const noLimit = [{ id: "openai", models: { "gpt-4.1": { limit: {} } } }] as any[]
    const m = getSessionContextMetrics([withContext("a", 40_000, 10_000)], noLimit).context!
    expect(m.window).toBe(40_000)
    expect(m.usage).toBeNull()
  })
})

// 260822 cc 输入框那个小悬浮改成显示「首字延迟 + 解码速率」之后，这两条口径就是它全部的
// 独立性所在，写错了没人看得出来（数字仍然"像那么回事"）。两个陷阱各钉一条。
describe("getSessionContextMetrics — 解码速率与首字延迟", () => {
  const timed = (
    id: string,
    tokens: { input: number; output: number; reasoning: number; read: number; write: number },
    time: { created: number; firstChunk?: number; completed?: number },
  ) =>
    ({
      id,
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-4.1",
      cost: 0,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.read, write: tokens.write },
      },
      time,
    }) as unknown as Message

  test("分子含 reasoning，分母从 firstChunk 起算", () => {
    // created→firstChunk 2000ms 是排队/预填，必须排除在速率之外；
    // firstChunk→completed 1000ms 里吐了 output 60 + reasoning 40 = 100 个字 → 100 tok/s。
    // 若误用 created 起算会得到 33.3；若漏掉 reasoning 会得到 60。
    const messages = [
      timed(
        "a1",
        { input: 10, output: 60, reasoning: 40, read: 0, write: 0 },
        {
          created: 1_000,
          firstChunk: 3_000,
          completed: 4_000,
        },
      ),
    ]
    const ctx = getSessionContextMetrics(messages).context
    expect(ctx?.decodeRate).toBe(100)
    expect(ctx?.firstChunkMs).toBe(2000)
  })

  test("流式中（未 completed）与纯工具往返（未吐字）都跳过，取上一条跑完的", () => {
    const messages = [
      timed(
        "a1",
        { input: 10, output: 100, reasoning: 0, read: 0, write: 0 },
        {
          created: 0,
          firstChunk: 500,
          completed: 1_500,
        },
      ),
      // 纯工具往返：跑完了但一个字都没吐
      timed(
        "a2",
        { input: 10, output: 0, reasoning: 0, read: 0, write: 0 },
        {
          created: 2_000,
          firstChunk: 2_100,
          completed: 2_200,
        },
      ),
      // 正在流式：还没 completed
      timed("a3", { input: 10, output: 30, reasoning: 0, read: 0, write: 0 }, { created: 3_000, firstChunk: 3_200 }),
    ]
    const ctx = getSessionContextMetrics(messages).context
    expect(ctx?.decodeRate).toBe(100)
    expect(ctx?.firstChunkMs).toBe(500)
  })

  test("完全没有计时数据时是 null，不是 0", () => {
    const ctx = getSessionContextMetrics([
      assistant("a1", { input: 10, output: 10, reasoning: 0, read: 0, write: 0 }, 0),
    ]).context
    expect(ctx?.decodeRate).toBeNull()
    expect(ctx?.firstChunkMs).toBeNull()
  })
})
