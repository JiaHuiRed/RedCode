// 260828 cc 缓存口径的闸门。
//
// `usePromptUsage` 是纯计算，编码了三件在界面上直接显示、又直接指导决策的东西：
// 本轮命中率 / 本次连接累计命中率 / 会话全历史命中率，外加"缓存冻结"判据。
// 这些数字此前只在 TUI 里被人眼看，没有任何测试 —— 而 08-04 那次前缀缓存被永久钉死
// （vision 临时文件名带 Date.now()）正是靠这组数字才诊断出来的。判据一旦被改坏，
// 下次同类事故就没有仪表可看了。
//
// 形态取自 deepseek-harness 的 web 快照：它把 `Cache hit 99%` 这类状态数字与界面渲染
// pin 在同一份文件里。本仓分两半 —— 数字在这里钉，渲染在 conversation 快照里钉。
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { usePromptUsage } from "@tui/component/prompt/usage"

type Turn = { read: number; miss?: number; write?: number }

/** 拼一个只包含 usePromptUsage 会读到的字段的假 sync。 */
function fakeSync(input: {
  sessionID: string
  turns: Turn[]
  record?: { input: number; cacheRead: number; cacheWrite: number }
}) {
  return {
    data: {
      message: {
        [input.sessionID]: input.turns.map((turn) => ({
          role: "assistant" as const,
          tokens: { cache: { read: turn.read, miss: turn.miss ?? 0, write: turn.write ?? 0 } },
        })),
      },
      session: input.record
        ? [
            {
              id: input.sessionID,
              tokens: { input: input.record.input, cache: { read: input.record.cacheRead, write: input.record.cacheWrite } },
            },
          ]
        : [],
    },
  } as unknown as Parameters<typeof usePromptUsage>[1]
}

function usage(input: Parameters<typeof fakeSync>[0]) {
  return createRoot((dispose) => {
    const result = usePromptUsage(() => input.sessionID, fakeSync(input))()
    dispose()
    return result
  })
}

describe("usePromptUsage 命中率三档", () => {
  test("没有消息、或一次 read 都没有时不出数", () => {
    expect(usage({ sessionID: "ses_a", turns: [] })).toBeUndefined()
    expect(usage({ sessionID: "ses_a", turns: [{ read: 0, miss: 5000 }] })).toBeUndefined()
  })

  // hit = read / (read + miss + write)。read+miss+write 三项都要算 —— session.ts 的
  // DeepSeek 缓存上限回落会把真实 miss 路由进 cache.write，二选一会把命中率算高。
  test("累计命中率把 write 也算进分母", () => {
    const both = usage({ sessionID: "ses_a", turns: [{ read: 900, miss: 100 }] })
    expect(both!.cacheHitPct).toBe(90)
    expect(both!.cacheMissPct).toBe(10)

    const routedToWrite = usage({ sessionID: "ses_a", turns: [{ read: 900, write: 100 }] })
    expect(routedToWrite!.cacheHitPct).toBe(90)
  })

  test("本轮命中率只看最后一轮，不被历史平均稀释", () => {
    const result = usage({
      sessionID: "ses_a",
      turns: [
        { read: 10_000, miss: 0 },
        { read: 10_000, miss: 0 },
        { read: 100, miss: 900 }, // 最后一轮塌了
      ],
    })
    expect(result!.turnHitPct).toBe(10)
    // 累计仍然很高 —— 这正是"累计值对冻结几乎没有诊断力"的量化说明
    expect(result!.cacheHitPct).toBeGreaterThan(95)
  })

  test("会话全历史取会话记录而不是内存里的消息（跨重启不丢）", () => {
    const result = usage({
      sessionID: "ses_a",
      turns: [{ read: 1000, miss: 0 }],
      record: { input: 300, cacheRead: 700, cacheWrite: 0 },
    })
    expect(result!.lifeHitPct).toBe(70)
    // 累计未命中按 token 数给，不给百分比 —— 百分比恒等于 100−hit，是冗余
    expect(result!.lifeMiss).toBe(300)
  })

  test("没有会话记录时全历史两项为空/零，不伪造", () => {
    const result = usage({ sessionID: "ses_a", turns: [{ read: 1000, miss: 0 }] })
    expect(result!.lifeHitPct).toBeUndefined()
    expect(result!.lifeMiss).toBe(0)
  })
})

// 判据：连续 3 轮 read 完全不变，且本轮未命中 > 3k。
// 按这条扫历史数据，三次真实冻结全部命中、健康轮次零误报（260804 实测）。
describe("usePromptUsage 冻结判据", () => {
  const stalled = (turns: Turn[]) => usage({ sessionID: "ses_a", turns })!.stalled

  test("命中真实的冻结形态：read 钉死、每轮重新付 write", () => {
    expect(
      stalled([
        { read: 97_000, write: 55_000 },
        { read: 97_000, write: 60_000 },
        { read: 97_000, write: 84_000 },
      ]),
    ).toBe(true)
  })

  test("read 还在长就不算冻结，哪怕未命中很大", () => {
    expect(
      stalled([
        { read: 97_000, write: 55_000 },
        { read: 110_000, write: 60_000 },
        { read: 114_000, write: 84_000 },
      ]),
    ).toBe(false)
  })

  test("read 不变但未命中很小 —— 那是正常的空闲轮，不报", () => {
    expect(
      stalled([
        { read: 97_000, write: 100 },
        { read: 97_000, write: 100 },
        { read: 97_000, write: 200 },
      ]),
    ).toBe(false)
  })

  test("只连续 2 轮不变还不够（阈值是 3 轮）", () => {
    expect(
      stalled([
        { read: 50_000, write: 9_000 },
        { read: 97_000, write: 9_000 },
        { read: 97_000, write: 9_000 },
      ]),
    ).toBe(false)
  })

  test("read 恒为 0 的会话不会被误判成冻结", () => {
    expect(usage({ sessionID: "ses_a", turns: [{ read: 0, write: 9_000 }] })).toBeUndefined()
  })
})
