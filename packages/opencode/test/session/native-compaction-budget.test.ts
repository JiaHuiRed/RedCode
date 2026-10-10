import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { NativeCompaction } from "../../src/config/native-compaction"
import { ceiling, isOverflow, level, usable } from "../../src/session/overflow"
import type { Config } from "../../src/config/config"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"

// 只需要 limit 与 api.id —— usable()/maxOutputTokens 用到的就这些
const model = (context: number, output: number, input?: number) =>
  ({
    id: "test-model",
    api: { id: "test-model" },
    limit: { context, output, ...(input ? { input } : {}) },
  }) as unknown as Provider.Model

const tokens = (total: number): MessageV2.Assistant["tokens"] => ({
  input: total,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  total,
})

const nativeCfg = (native: unknown, extra?: Record<string, unknown>) =>
  ({ compaction: { ...extra, native } }) as unknown as Config.Info

const decode = (value: unknown) => Schema.decodeUnknownSync(NativeCompaction.Info)(value)

// 261010 Red native compaction 预算：默认全关（enabled false）保证不动现有压缩路径；
// 打开后 overflow 的 ceiling/isOverflow/level 改看 resolve 出的 trigger（已按模型
// usable 夹过）。数字全部写死期望值，不镜像实现里的常量。

describe("NativeCompaction.resolve 默认值", () => {
  test("enabled 缺省 false —— 不打开就不碰 legacy 压缩路径", () => {
    expect(NativeCompaction.resolve(undefined).enabled).toBe(false)
    expect(NativeCompaction.resolve({}).enabled).toBe(false)
  })

  test("完整默认预算", () => {
    expect(NativeCompaction.resolve(undefined)).toEqual({
      enabled: false,
      triggerTokens: 250_000,
      targetTokens: 130_000,
      reminderTokens: 220_000,
      softRatio: 0.72,
      pruneRatio: 0.88,
      summaryMaxTokens: 16_000,
      summaryMaxBytes: 98_304,
      activeMaxTokens: 80_000,
      activeMaxBytes: 524_288,
      maxRanges: 8,
      maxBlocks: 128,
      maxMessages: 4096,
      readMaxTokens: 2048,
      readMaxBytes: 8192,
      searchScanBytes: 4_194_304,
      searchMaxResults: 10,
      protectUserMessages: true,
      protectedTools: ["task", "task_status", "skill", "todowrite", "todoread"],
    })
  })
})

describe("snake_case 配置映射到 camelCase Spec", () => {
  test("每个选项都能显式覆盖", () => {
    expect(
      NativeCompaction.resolve({
        enabled: true,
        trigger_tokens: 300_000,
        target_tokens: 200_000,
        reminder_tokens: 260_000,
        soft_ratio: 0.7,
        prune_ratio: 0.9,
        summary_max_tokens: 8_000,
        summary_max_bytes: 65_536,
        active_max_tokens: 40_000,
        active_max_bytes: 262_144,
        max_ranges: 4,
        max_blocks: 64,
        max_messages: 1_024,
        read_max_tokens: 1_024,
        read_max_bytes: 4_096,
        search_scan_bytes: 1_048_576,
        search_max_results: 5,
        protect_user_messages: false,
        protected_tools: ["task", "bash"],
      }),
    ).toEqual({
      enabled: true,
      triggerTokens: 300_000,
      targetTokens: 200_000,
      reminderTokens: 260_000,
      softRatio: 0.7,
      pruneRatio: 0.9,
      summaryMaxTokens: 8_000,
      summaryMaxBytes: 65_536,
      activeMaxTokens: 40_000,
      activeMaxBytes: 262_144,
      maxRanges: 4,
      maxBlocks: 64,
      maxMessages: 1_024,
      readMaxTokens: 1_024,
      readMaxBytes: 4_096,
      searchScanBytes: 1_048_576,
      searchMaxResults: 5,
      protectUserMessages: false,
      protectedTools: ["task", "bash"],
    })
  })
})

describe("配置校验", () => {
  test("预警比例必须有限且满足 0 < soft < prune < 1", () => {
    for (const bad of [0, -1, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decode({ soft_ratio: bad })).toThrow()
      expect(() => decode({ prune_ratio: bad })).toThrow()
    }
    expect(() => decode({ soft_ratio: 0.9 })).toThrow()
    expect(() => decode({ prune_ratio: 0.7 })).toThrow()
    expect(() => decode({ soft_ratio: 0.8, prune_ratio: 0.8 })).toThrow()
    expect(decode({ soft_ratio: 0.7, prune_ratio: 0.9 })).toMatchObject({
      soft_ratio: 0.7,
      prune_ratio: 0.9,
    })
  })

  test("token 预算必须为正、有限、有上界", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001]) {
      expect(() => decode({ trigger_tokens: bad })).toThrow()
    }
    expect(decode({ trigger_tokens: 10_000_000 }).trigger_tokens).toBe(10_000_000)
  })

  test("计数字段有实用上界", () => {
    const counts: Array<[keyof NativeCompaction.Info, number]> = [
      ["max_ranges", 1024],
      ["max_blocks", 16_384],
      ["max_messages", 65_536],
      ["search_max_results", 1000],
    ]
    for (const [field, max] of counts) {
      expect(() => decode({ [field]: max + 1 })).toThrow()
      expect(decode({ [field]: max })[field]).toBe(max)
    }
  })

  test("target/reminder/trigger 顺序错误在模型夹取之前就拒", () => {
    // target 超过默认 trigger（250k）
    expect(() => decode({ target_tokens: 300_000 })).toThrow()
    // reminder 超过默认 trigger
    expect(() => decode({ reminder_tokens: 260_000 })).toThrow()
    // 显式 trigger 下 target 仍然超
    expect(() => decode({ trigger_tokens: 200_000, target_tokens: 250_000 })).toThrow()
    // resolve 也是先拒后夹，不拿夹取悄悄修正配错的意图
    expect(() => NativeCompaction.resolve({ target_tokens: 300_000 }, 100_000)).toThrow()
    // 合法顺序放过
    expect(decode({ trigger_tokens: 300_000, target_tokens: 200_000, reminder_tokens: 260_000 }).reminder_tokens).toBe(
      260_000,
    )
  })
})

describe("resolve 的模型夹取", () => {
  test("usable 缺省或为 0（窗口未知）时 trigger 保持 250k", () => {
    expect(NativeCompaction.resolve({ enabled: true }).triggerTokens).toBe(250_000)
    expect(NativeCompaction.resolve({ enabled: true }, 0).triggerTokens).toBe(250_000)
  })

  test("窗口够大时不夹取", () => {
    const spec = NativeCompaction.resolve({ enabled: true }, 872_000)
    expect(spec.triggerTokens).toBe(250_000)
    expect(spec.targetTokens).toBe(130_000)
    expect(spec.reminderTokens).toBe(220_000)
  })

  test("小模型按配置里的比例同步缩小 target/reminder", () => {
    const spec = NativeCompaction.resolve({ enabled: true }, 84_000)
    expect(spec.triggerTokens).toBe(84_000)
    expect(spec.targetTokens).toBe(43_680)
    expect(spec.reminderTokens).toBe(73_920)
    expect(spec.targetTokens).toBeLessThan(spec.reminderTokens)
    expect(spec.reminderTokens).toBeLessThan(spec.triggerTokens)
  })

  test("夹取用的是配置比例，不是默认比例", () => {
    const spec = NativeCompaction.resolve(
      { enabled: true, trigger_tokens: 100_000, target_tokens: 50_000, reminder_tokens: 80_000 },
      50_000,
    )
    expect(spec).toMatchObject({ triggerTokens: 50_000, targetTokens: 25_000, reminderTokens: 40_000 })
  })

  test("夹取不动其余预算字段", () => {
    const spec = NativeCompaction.resolve({ enabled: true, max_ranges: 4, search_max_results: 3 }, 84_000)
    expect(spec.maxRanges).toBe(4)
    expect(spec.searchMaxResults).toBe(3)
  })
})

describe("overflow native 触发点", () => {
  // usable = 1_000_000 - 128_000 = 872_000（maxOutputTokens 夹到 CAP）
  const big = model(1_000_000, 131_072)
  // usable = 100_000 - 16_000 = 84_000
  const small = model(100_000, 16_000)
  // context 为 0 = 窗口未知，usable() 返回 0
  const unknownWindow = model(0, 0)

  test("默认关闭时行为不变（legacy 路径）", () => {
    const cfg = {} as Config.Info
    expect(ceiling({ cfg, model: big })).toBe(usable({ cfg, model: big }))
    expect(isOverflow({ cfg, tokens: tokens(872_000), model: big })).toBe(true)
    expect(isOverflow({ cfg, tokens: tokens(871_999), model: big })).toBe(false)
  })

  test("native 打开后 ceiling/isOverflow 看 native trigger", () => {
    const cfg = nativeCfg({ enabled: true })
    expect(ceiling({ cfg, model: big })).toBe(250_000)
    expect(isOverflow({ cfg, tokens: tokens(250_000), model: big })).toBe(true)
    expect(isOverflow({ cfg, tokens: tokens(249_999), model: big })).toBe(false)
  })

  test("小模型：trigger 夹到 usable，仍然能触发", () => {
    const cfg = nativeCfg({ enabled: true })
    expect(ceiling({ cfg, model: small })).toBe(84_000)
    expect(isOverflow({ cfg, tokens: tokens(84_000), model: small })).toBe(true)
    expect(isOverflow({ cfg, tokens: tokens(83_999), model: small })).toBe(false)
  })

  test("窗口未知时 trigger 保持 250k（legacy 路径在这种情况下不触发）", () => {
    const cfg = nativeCfg({ enabled: true })
    expect(ceiling({ cfg, model: unknownWindow })).toBe(250_000)
    expect(isOverflow({ cfg, tokens: tokens(250_000), model: unknownWindow })).toBe(true)
    expect(isOverflow({ cfg, tokens: tokens(249_999), model: unknownWindow })).toBe(false)
    const legacy = {} as Config.Info
    expect(isOverflow({ cfg: legacy, tokens: tokens(999_999), model: unknownWindow })).toBe(false)
  })

  test("native 在 180k/220k/250k 分档，只有 250k 触发压缩", () => {
    const cfg = nativeCfg({ enabled: true })
    expect(level({ cfg, tokens: tokens(179_999), model: big })).toBe("ok")
    expect(level({ cfg, tokens: tokens(180_000), model: big })).toBe("soft")
    expect(level({ cfg, tokens: tokens(219_999), model: big })).toBe("soft")
    expect(level({ cfg, tokens: tokens(220_000), model: big })).toBe("prune")
    expect(level({ cfg, tokens: tokens(249_999), model: big })).toBe("prune")
    expect(level({ cfg, tokens: tokens(250_000), model: big })).toBe("compact")
    expect(isOverflow({ cfg, tokens: tokens(220_000), model: big })).toBe(false)
    expect(isOverflow({ cfg, tokens: tokens(249_999), model: big })).toBe(false)
    expect(isOverflow({ cfg, tokens: tokens(250_000), model: big })).toBe(true)
  })

  test("预警比例可覆盖，小窗口保持同一比例，legacy 分档不变", () => {
    const cfg = nativeCfg({ enabled: true, soft_ratio: 0.5, prune_ratio: 0.9 })
    expect(level({ cfg, tokens: tokens(125_000), model: big })).toBe("soft")
    expect(level({ cfg, tokens: tokens(225_000), model: big })).toBe("prune")
    expect(level({ cfg, tokens: tokens(41_999), model: small })).toBe("ok")
    expect(level({ cfg, tokens: tokens(42_000), model: small })).toBe("soft")
    expect(level({ cfg, tokens: tokens(75_600), model: small })).toBe("prune")
    expect(level({ cfg, tokens: tokens(84_000), model: small })).toBe("compact")
    const legacy = { compaction: { threshold: 250_000 } } as Config.Info
    expect(level({ cfg: legacy, tokens: tokens(150_000), model: big })).toBe("soft")
    expect(level({ cfg: legacy, tokens: tokens(200_000), model: big })).toBe("prune")
  })

  test("auto:false 时 native 同样不触发、不分档", () => {
    const cfg = nativeCfg({ enabled: true }, { auto: false })
    expect(isOverflow({ cfg, tokens: tokens(999_999), model: big })).toBe(false)
    expect(level({ cfg, tokens: tokens(999_999), model: big })).toBe("ok")
  })

  test("native 打开时 legacy threshold 不参与", () => {
    const cfg = nativeCfg({ enabled: true }, { threshold: 400_000 })
    expect(ceiling({ cfg, model: big })).toBe(250_000)
    expect(isOverflow({ cfg, tokens: tokens(300_000), model: big })).toBe(true)
  })

  test("legacy threshold 在 native 关闭时照旧生效", () => {
    const cfg = { compaction: { threshold: 400_000 } } as Config.Info
    expect(ceiling({ cfg, model: big })).toBe(400_000)
    expect(isOverflow({ cfg, tokens: tokens(400_000), model: big })).toBe(true)
    expect(isOverflow({ cfg, tokens: tokens(399_999), model: big })).toBe(false)
  })
})
