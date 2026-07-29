import { describe, expect, test } from "bun:test"
import { isOverflow, level, RATIOS, usable } from "../../src/session/overflow"
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

  test("模型缺少 api 字段也不抛 —— isMimoModel 的空值保护", () => {
    const bare = { id: "mimo-test", limit: { context: 100_000, output: 8_000 } } as unknown as Provider.Model
    expect(() => level({ cfg, tokens: tokens(10), model: bare })).not.toThrow()
  })
})
