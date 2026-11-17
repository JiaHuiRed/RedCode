// 261028 Red 子代理页脚用量行：总 token + cache 命中率口径。
// 口径守门：read/(read+miss+write) 三桶无条件求和，与主会话三处显示对齐
// （prompt-usage.test.ts 同款断点）；混桶场景是 260707 修 inflated hit 的回归点——
// 子代理页脚此前停在 260614 的 either/or 链，一直没跟上。
import { describe, expect, test } from "bun:test"
import { subagentUsage } from "../../../../src/cli/cmd/tui/routes/session/subagent-usage"
import type { Message } from "@redcode-ai/sdk/v2"

function msg(over: { read?: number; miss?: number; write?: number; input?: number; output?: number; reasoning?: number }) {
  return {
    role: "assistant",
    tokens: {
      input: over.input ?? 0,
      output: over.output ?? 0,
      reasoning: over.reasoning ?? 0,
      cache: { read: over.read ?? 0, miss: over.miss ?? 0, write: over.write ?? 0 },
    },
  } as unknown as Message
}

// 千分位随 locale 变，期望值用同一函数生成，只钉结构不钉 locale
const n = (x: number) => x.toLocaleString()

describe("子代理页脚用量行", () => {
  test("总 token 按已加载消息累计（input+output+reasoning+read+write）", () => {
    expect(subagentUsage([msg({ input: 1000, output: 200, read: 800, miss: 200 })])?.label).toBe(
      `Cache: 80% · Total ${n(2000)}`,
    )
  })

  test("聚合行优先于已加载子集：长子代理下总量以服务端会话行为准", () => {
    const usage = subagentUsage([msg({ input: 1000, output: 200, read: 800, miss: 200 })], {
      tokens: { input: 5000, output: 1000, reasoning: 500, cache: { read: 4000, write: 500 } },
    })
    // 总量取聚合行 5000+1000+500+4000+500；cache 仍按已加载消息算（聚合行没有 miss 分桶）
    expect(usage?.label).toBe(`Cache: 80% · Total ${n(11000)}`)
  })

  test("混桶会话：miss 与 write 同时非零时两桶都进分母（260707 回归点）", () => {
    // 旧 either/or 链：miss>0 → 分母只取 read+miss=1000 → 虚报 80%，write 整桶被丢
    // 对齐后：read/(read+miss+write)=800/1200=66.7%
    // fixture 守 miss === input 构造：fresh 200 记进 miss（=input），另 200 记进 write
    expect(subagentUsage([msg({ read: 800, miss: 200, write: 200, input: 200 })])?.label).toBe(
      `Cache: 66.7% · Total ${n(1200)}`,
    )
  })

  test("只有 write 没有 miss（DeepSeek cache-cap 回退路径）口径一致", () => {
    // fresh 全进 write 桶、input=0：分母 read+write，与主会话同口径
    expect(subagentUsage([msg({ read: 800, write: 200 })])?.label).toBe(`Cache: 80% · Total ${n(1000)}`)
  })

  test("没有 cache 的供应商只显示总 token，不再整行吞掉", () => {
    expect(subagentUsage([msg({ input: 1500, output: 300 })])?.label).toBe(`Total ${n(1800)}`)
  })

  test("零用量不显示行", () => {
    expect(subagentUsage([])).toBeUndefined()
    expect(subagentUsage([msg({})])).toBeUndefined()
  })
})
