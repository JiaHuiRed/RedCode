import { describe, expect, test } from "bun:test"
import { bar, barColor, compact, contextSource, formatMs, sessionUsage } from "../../../../src/cli/cmd/tui/feature-plugins/sidebar/context"
import type { AssistantMessage, Message } from "@redcode-ai/sdk/v2"

// 260819 cc: 侧边栏上下文窗口的显示件。侧边栏宽 42 列，紧凑记法和进度条宽度都按这个定的。
describe("sidebar context window 显示", () => {
  test("compact 按量级切换单位", () => {
    expect(compact(0)).toBe("0")
    expect(compact(999)).toBe("999")
    expect(compact(1_000)).toBe("1k")
    expect(compact(185_925)).toBe("186k") // >=100k 取整，避免 185.9k 多占一列
    expect(compact(12_500)).toBe("12.5k")
    expect(compact(1_000_000)).toBe("1M")
    expect(compact(15_416_562)).toBe("15M")
    expect(compact(1_250_000)).toBe("1.3M")
  })

  test("bar 两段加起来恒为固定宽度，端点不越界", () => {
    for (const p of [0, 1, 19, 50, 99, 100]) {
      const { filled, rest } = bar(p)
      expect([...filled].length + [...rest].length).toBe(24)
    }
    expect(bar(0).filled).toBe("")
    expect(bar(100).rest).toBe("")
  })

  // 口径修好之前 percent 会飙到几百，条子不能因此画出格
  test("bar 对越界百分比钳制而不是画穿", () => {
    expect([...bar(300).filled].length).toBe(24)
    expect(bar(300).rest).toBe("")
    expect([...bar(-5).filled].length).toBe(0)
  })

  // 261012 Red 颜色档位与 400k 兜底对齐：<320k 绿、320-360k 黄、360-400k 橙、≥400k 红。
  test("barColor 四档按 400k 兜底分档", () => {
    const colors = [100_000, 340_000, 380_000, 410_000].map(barColor)
    expect(new Set(colors).size).toBe(4)
    const green = barColor(0)
    const yellow = barColor(320_000)
    const orange = barColor(360_000)
    const red = barColor(400_000)
    expect(barColor(319_999)).toBe(green)
    expect(barColor(320_000)).toBe(yellow)
    expect(barColor(359_999)).toBe(yellow)
    expect(barColor(360_000)).toBe(orange)
    expect(barColor(399_999)).toBe(orange)
    expect(barColor(400_000)).toBe(red)
  })

  test("上下文缺失（历史消息没有该字段）回落到 ok 的颜色，不报错", () => {
    expect(barColor(undefined)).toBe(barColor(0))
    expect(barColor(null)).toBe(barColor(0))
  })
})

// 260819 cc 解码速率显示。数据来自 message-v2 的 time.firstChunk/completed（埋点
// processor.ts 的 llm.ttft），实测最近 400 条 assistant 消息 400 条有值。
describe("首字延迟格式化", () => {
  test("秒级用 s，毫秒级用 ms", () => {
    expect(formatMs(2423)).toBe("2.4s")
    expect(formatMs(999)).toBe("999ms")
    expect(formatMs(1000)).toBe("1s")
    expect(formatMs(0)).toBe("0ms")
  })

  test("秒级只保留一位小数，不出现 2.42s 这种挤版的写法", () => {
    for (const ms of [1234, 5678, 12345, 98765]) {
      expect(formatMs(ms)).toMatch(/^\d+(\.\d)?s$/)
    }
  })
})

// 261010 Red 625 是摘要请求，不是原会话上下文；摘要成功/失败都不能顶替主请求用量。
describe("摘要请求与主会话用量分离", () => {
  function assistant(id: string, context: number, summary = false): AssistantMessage {
    return {
      id, sessionID: "ses_sidebar", role: "assistant", parentID: "msg_user",
      agent: "build", mode: "build", modelID: "test", providerID: "test",
      path: { cwd: ".", root: "." }, time: { created: 1 }, cost: 1, summary,
      tokens: { context, input: context, output: 100, reasoning: 0, cache: { read: 0, write: 0, miss: context } },
    }
  }

  test.each([false, true])("摘要失败=%s 不改变主会话上下文", (failed) => {
    const main = assistant("msg_main", 124000)
    const summary = assistant("msg_summary", 625, true)
    if (failed) summary.error = { name: "ContextOverflowError", data: { message: "Compression has no positive savings after protection" } }
    expect(contextSource([main, summary])).toEqual(main)
  })

  test("只有摘要时不捏造上下文，但仍累计其调用用量", () => {
    const summary = assistant("msg_summary", 625, true)
    expect(contextSource([summary])).toBeUndefined()
    expect(sessionUsage([summary]).sessionTotal).toBe(725)
  })

  test("主会话续跑更新上下文，摘要用量仍计入总数", () => {
    const first = assistant("msg_first", 124000)
    const summary = assistant("msg_summary", 625, true)
    const next = assistant("msg_next", 130000)
    expect(contextSource([first, summary, next])).toEqual(next)
    expect(sessionUsage([first, summary, next]).sessionTotal).toBe(254925)
    expect(sessionUsage([first, summary, next]).output).toBe(300)
  })

  // 261011 Red 现场：TUI 的 Session total 显示 1.8 千万，会话真实累计 1.3 亿——msg() 是分页
  // 已加载子集，只有服务端会话行聚合才是全量账。口径与 GUI session-context-metrics 同款。
  test("会话累计优先用服务端会话行聚合（分页子集只覆盖已加载消息）", () => {
    const first = assistant("msg_first", 124000)
    const second = assistant("msg_second", 130000)
    const aggregate = {
      tokens: { input: 500, output: 2000, reasoning: 1000, cache: { read: 130_000_000, write: 1_500_000 } },
    }
    const usage = sessionUsage([first, second], aggregate)
    expect(usage.sessionTotal).toBe(500 + 2000 + 1000 + 130_000_000 + 1_500_000)
    // 比率与明细仍按已加载消息算，不受聚合影响
    expect(usage.output).toBe(200)
  })

  test("聚合缺失（旧行或尚未回填）退回子集累计", () => {
    const first = assistant("msg_first", 124000)
    expect(sessionUsage([first]).sessionTotal).toBe(124100)
    expect(sessionUsage([first], {}).sessionTotal).toBe(124100)
  })
})


// 261028 Red 子代理用量并入 Session total（GUI 模型按钮悬停「父+子成本桶」的 TUI 对应面）。
// 数据源是 session.children 端点拿到的全量子会话行，行上带 projector 维护的 token 聚合；
// 命中率等比率没有子会话消息可算，仍只覆盖本会话。
describe("子代理用量并入会话累计", () => {
 const row = (t: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) => ({
   tokens: t,
 })
 const msg = (read: number, miss: number) =>
   ({
     role: "assistant",
     tokens: { input: miss, output: 100, reasoning: 0, cache: { read, miss, write: 0 } },
   }) as unknown as Message

 test("子代理用量并入 Session total，并单独给出拆分量", () => {
   const usage = sessionUsage(
     [],
     { tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 800, write: 100 } } },
     [row({ input: 400, output: 100, reasoning: 50, cache: { read: 2000, write: 200 } })],
   )
   expect(usage.subagentTotal).toBe(400 + 100 + 50 + 2000 + 200)
   expect(usage.sessionTotal).toBe(100 + 50 + 0 + 800 + 100 + (400 + 100 + 50 + 2000 + 200))
 })

 test("多个子代理累加，缺 tokens 的旧行计 0", () => {
   const usage = sessionUsage([], undefined, [
     row({ input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
     { tokens: undefined },
     row({ input: 200, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
   ])
   expect(usage.subagentTotal).toBe(300)
   expect(usage.sessionTotal).toBe(300)
 })

 test("不传子代理时行为不变（拆分量为 0）", () => {
   const aggregate = {
     tokens: { input: 500, output: 2000, reasoning: 1000, cache: { read: 130_000_000, write: 1_500_000 } },
   }
   const usage = sessionUsage([], aggregate)
   expect(usage.subagentTotal).toBe(0)
   expect(usage.sessionTotal).toBe(500 + 2000 + 1000 + 130_000_000 + 1_500_000)
 })

 test("命中率与输出明细仍只算本会话，不被子代理污染", () => {
   const usage = sessionUsage([msg(800, 200)], undefined, [
     row({ input: 9000, output: 9000, reasoning: 0, cache: { read: 9000, write: 0 } }),
   ])
   expect(usage.cacheHit).toBe(80)
   expect(usage.output).toBe(100)
   expect(usage.subagentTotal).toBe(27000)
   expect(usage.sessionTotal).toBe(1100 + 27000)
 })
})