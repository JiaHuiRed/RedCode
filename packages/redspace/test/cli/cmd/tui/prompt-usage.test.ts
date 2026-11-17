// 260809 Red usage 统计 hook 的行为等价测试。
// 测纯计算逻辑：三档命中率 + stalled 冻结判据 + 各边界。
import { describe, expect, test } from "bun:test"
import { usePromptUsage } from "../../../../src/cli/cmd/tui/component/prompt/usage"

// 构造 sync 的最小替身（只含 usage 用到的字段）
function makeSync(messages: unknown[], sessions: unknown[] = []) {
  return {
    data: {
      message: { s1: messages },
      session: sessions,
    },
  } as unknown as Parameters<typeof usePromptUsage>[1]
}

function msg(over: { read?: number; miss?: number; write?: number; input?: number; output?: number }) {
  return {
    role: "assistant",
    tokens: {
      input: over.input ?? 0,
      output: over.output ?? 0,
      reasoning: 0,
      cache: { read: over.read ?? 0, miss: over.miss ?? 0, write: over.write ?? 0 },
    },
  }
}

describe("usePromptUsage", () => {
  test("无 sessionID 返回 undefined", () => {
    const usage = usePromptUsage(() => undefined, makeSync([]))
    expect(usage()).toBeUndefined()
  })

  test("无消息返回 undefined", () => {
    const usage = usePromptUsage(() => "s1", makeSync([]))
    expect(usage()).toBeUndefined()
  })

  test("全部命中：hit=100%，turn/conn/life 一致，无 stalled", () => {
    const messages = [msg({ read: 1000, miss: 0, input: 1000 }), msg({ read: 2000, miss: 0, input: 2000 })]
    // life 语义：input 即全价未命中部分（session.ts cache.miss === input by construction），
    // 全命中场景 input=0 → lifeMiss=0, lifeHitPct=100
    const sessions = [{ id: "s1", tokens: { input: 0, cache: { read: 3000, write: 0 } } }]
    const usage = usePromptUsage(() => "s1", makeSync(messages, sessions))
    expect(usage()).toEqual({
      cacheHitPct: 100,
      cacheMissPct: 0,
      turnHitPct: 100,
      stalled: false,
      lifeHitPct: 100,
      lifeMiss: 0,
    })
  })

  test("混合命中：按 read/(read+miss+write) 计算 conn 命中率", () => {
    const messages = [msg({ read: 800, miss: 200, input: 1000 })]
    const usage = usePromptUsage(() => "s1", makeSync(messages))
    expect(usage()?.cacheHitPct).toBe(80)
    expect(usage()?.cacheMissPct).toBe(20)
  })

  test("stalled 判据：连续 3 轮 read 不变且本轮 miss>3000", () => {
    const messages = [
      msg({ read: 1000, miss: 4000, input: 5000 }),
      msg({ read: 1000, miss: 4000, input: 5000 }),
      msg({ read: 1000, miss: 4000, input: 5000 }),
    ]
    const usage = usePromptUsage(() => "s1", makeSync(messages))
    expect(usage()?.stalled).toBe(true)
  })

  test("read 在增长不算 stalled", () => {
    const messages = [
      msg({ read: 1000, miss: 4000, input: 5000 }),
      msg({ read: 1100, miss: 4000, input: 5100 }),
      msg({ read: 1200, miss: 4000, input: 5200 }),
    ]
    const usage = usePromptUsage(() => "s1", makeSync(messages))
    expect(usage()?.stalled).toBe(false)
  })

  test("miss 未超阈值不算 stalled", () => {
    const messages = [
      msg({ read: 1000, miss: 100, input: 1100 }),
      msg({ read: 1000, miss: 100, input: 1100 }),
      msg({ read: 1000, miss: 100, input: 1100 }),
    ]
    const usage = usePromptUsage(() => "s1", makeSync(messages))
    expect(usage()?.stalled).toBe(false)
  })

  test("life 统计取会话记录（跨重启），miss 按 input+write 计", () => {
    const messages = [msg({ read: 100, miss: 10, write: 5, input: 15 })]
    const sessions = [{ id: "s1", tokens: { input: 500, cache: { read: 400, write: 100 } } }]
    const usage = usePromptUsage(() => "s1", makeSync(messages, sessions))
    // lifeRead=400, lifeMiss=input(500)+write(100)=600, lifeDenom=1000 → 40%
    expect(usage()?.lifeHitPct).toBe(40)
    expect(usage()?.lifeMiss).toBe(600)
  })
})
