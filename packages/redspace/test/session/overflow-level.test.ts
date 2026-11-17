import { describe, expect, test } from "bun:test"
import { isOverflow, level, RATIOS, usable } from "../../src/session/overflow"
import { maxOutputTokens, OUTPUT_TOKEN_CAP, OUTPUT_TOKEN_MAX } from "../../src/provider/transform"
import type { Config } from "../../src/config/config"
import type { Provider } from "../../src/provider/provider"

const cfg = {} as Config.Info

// 只需要 limit 与 api.id —— usable()/maxOutputTokens 用到的就这些
const model = (context: number, output: number, input?: number) =>
  ({
    id: "test-model",
    api: { id: "test-model" },
    limit: { context, output, ...(input ? { input } : {}) },
  }) as unknown as Provider.Model

const tokens = (total: number) =>
  ({ input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total }) as any

describe("overflow.level 分级", () => {
  const m = model(200_000, 16_000)
  const limit = usable({ cfg, model: m })

  test("usable 是正数，测试前提成立", () => {
    expect(limit).toBeGreaterThan(0)
  })

  test("低用量为 ok", () => {
    expect(level({ cfg, tokens: tokens(Math.floor(limit * 0.1)), model: m })).toBe("ok")
  })

  test("刚好越过 soft 线为 soft", () => {
    expect(level({ cfg, tokens: tokens(Math.ceil(limit * RATIOS.soft)), model: m })).toBe("soft")
  })

  test("soft 线之下仍是 ok（边界不早触发）", () => {
    expect(level({ cfg, tokens: tokens(Math.floor(limit * RATIOS.soft) - 1), model: m })).toBe("ok")
  })

  test("越过 prune 线为 prune", () => {
    expect(level({ cfg, tokens: tokens(Math.ceil(limit * RATIOS.prune)), model: m })).toBe("prune")
  })

  test("到达 usable 为 compact，且与 isOverflow 完全等价", () => {
    const t = tokens(limit)
    expect(level({ cfg, tokens: t, model: m })).toBe("compact")
    expect(isOverflow({ cfg, tokens: t, model: m })).toBe(true)
  })

  test("compact 档之外 isOverflow 均为 false —— 分级没有改变原有触发时机", () => {
    for (const ratio of [0.1, RATIOS.soft, RATIOS.prune, 0.99]) {
      const t = tokens(Math.floor(limit * ratio))
      const lv = level({ cfg, tokens: t, model: m })
      expect(isOverflow({ cfg, tokens: t, model: m })).toBe(lv === "compact")
    }
  })

  test("档位单调递增，不会跳档或回退", () => {
    const order = { ok: 0, soft: 1, prune: 2, compact: 3 }
    let prev = -1
    for (let r = 0; r <= 1.05; r += 0.05) {
      const lv = level({ cfg, tokens: tokens(Math.floor(limit * r)), model: m })
      expect(order[lv]).toBeGreaterThanOrEqual(prev)
      prev = order[lv]
    }
  })
})

describe("overflow.level 关闭自动压缩时", () => {
  test("auto:false 一律 ok，不做任何提示或裁剪", () => {
    const m = model(200_000, 16_000)
    const off = { compaction: { auto: false } } as Config.Info
    const limit = usable({ cfg, model: m })
    for (const ratio of [RATIOS.soft, RATIOS.prune, 1.2]) {
      expect(level({ cfg: off, tokens: tokens(Math.floor(limit * ratio)), model: m })).toBe("ok")
    }
  })
})

describe("overflow.level 退化情形", () => {
  test("context 为 0（自定义 provider 无声明）不崩、判为 ok", () => {
    const m = model(0, 0)
    expect(level({ cfg, tokens: tokens(999_999), model: m })).toBe("ok")
  })

  test("模型缺少 api 字段也不抛 —— maxOutputTokens 的空值保护", () => {
    const bare = { id: "mimo-test", limit: { context: 100_000, output: 8_000 } } as unknown as Provider.Model
    expect(() => level({ cfg, tokens: tokens(10), model: bare })).not.toThrow()
  })
})

// 260824 cc 输出预算改为按目录推导后的回归。数字取自实际模型目录，不是构造的。
describe("maxOutputTokens 按目录推导", () => {
  test("有 limit.input 时不夹 fraction —— step-3.7-flash 256K/256K 拿满 CAP", () => {
    // usable() 走 limit.input - reserved(恒 20000)，输出预算不吃上下文，故不夹
    expect(maxOutputTokens(model(256_000, 256_000, 256_000))).toBe(OUTPUT_TOKEN_CAP)
  })

  test("无 limit.input 但窗口够大时也拿满 —— x-preview-f-free 1M/131072", () => {
    expect(maxOutputTokens(model(1_000_000, 131_072))).toBe(OUTPUT_TOKEN_CAP)
  })

  test("不超过模型自己声明的 output —— deepseek-v4-flash 1048560/65536", () => {
    expect(maxOutputTokens(model(1_048_560, 65_536))).toBe(65_536)
  })

  test("context≈output 的模型被 fraction 夹住 —— kimi-k2.7-code 256K/256K 无 input", () => {
    expect(maxOutputTokens(model(256_000, 256_000))).toBe(64_000)
  })

  test("声明 output 低于下限时以声明值为准，绝不超发", () => {
    expect(maxOutputTokens(model(32_000, 8_000))).toBe(8_000)
  })

  test("目录没声明 output 时落到下限", () => {
    expect(maxOutputTokens(model(200_000, 0))).toBe(OUTPUT_TOKEN_MAX)
  })

  test("退役的两条特例，推导值都不低于它们原来给的", () => {
    // deepseek-v4-flash 原特例 50_000、mimo-v2.5 原特例 100_000
    expect(maxOutputTokens(model(1_048_560, 65_536))).toBeGreaterThanOrEqual(50_000)
    expect(maxOutputTokens(model(1_048_576, 131_072))).toBeGreaterThanOrEqual(100_000)
  })

  test("提高输出上限不会缩小 step 的 usable（limit.input 分支对其免疫）", () => {
    const step = model(256_000, 256_000, 256_000)
    expect(usable({ cfg, model: step })).toBe(256_000 - 20_000)
  })
})
