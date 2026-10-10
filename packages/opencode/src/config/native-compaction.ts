export * as NativeCompaction from "./native-compaction"

import { Schema } from "effect"

// 261010 Red native compaction 预算配置。默认全关（enabled 缺省 false）：不打开时
// session/overflow 的 ceiling/isOverflow/level 与 legacy threshold 路径逐字节一致，
// 现有会话一个都不受影响。打开后触发点才改看 resolve() 出的 trigger（已按模型
// usable 夹过）。
//
// 两类校验都落在 schema 上，不让 resolve 的模型夹取去悄悄修正配错的意图：
//   数值  正、有限（Int）、有实用上界——上界是"明显是笔误"的拦截线，不是业务上限
//   顺序  target <= reminder <= trigger，缺省值参与比较（只配 target 也会被拒）

const MAX_TOKENS = 10_000_000
const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_ACTIVE_BYTES = 256 * 1024 * 1024
const MAX_SCAN_BYTES = 1024 * 1024 * 1024

const TRIGGER_DEFAULT = 250_000
const TARGET_DEFAULT = 130_000
const REMINDER_DEFAULT = 220_000

const bounded = (max: number, description: string) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max })).annotate({ description })

const Fields = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable the native compaction budget (default: false). While off, the legacy compaction.threshold / model-window path is unchanged.",
  }),
  trigger_tokens: Schema.optional(
    bounded(
      MAX_TOKENS,
      "Token count that triggers native compaction, clamped to the model's usable window (default: 250000; maximum: 10000000)",
    ),
  ),
  target_tokens: Schema.optional(
    bounded(
      MAX_TOKENS,
      "Token count native compaction aims for after summarizing, scaled down with the trigger when the model window is smaller (default: 130000; maximum: 10000000)",
    ),
  ),
  reminder_tokens: Schema.optional(
    bounded(
      MAX_TOKENS,
      "Token count at which the user is reminded to compact before the trigger fires, scaled down with the trigger when the model window is smaller (default: 220000; maximum: 10000000)",
    ),
  ),
  // 261010 Red 预警颜色只调整显示时机，不提前触发摘要；比例随模型可用窗口同步缩放。
  soft_ratio: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).annotate({
      description:
        "Soft context warning as a fraction of the native trigger (default: 0.72; 180000 at a 250000 trigger)",
    }),
  ),
  prune_ratio: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).annotate({
      description:
        "Prune context warning as a fraction of the native trigger (default: 0.88; 220000 at a 250000 trigger); native mode does not run legacy pruning",
    }),
  ),
  summary_max_tokens: Schema.optional(
    bounded(1_000_000, "Maximum tokens of one compaction summary (default: 16000; maximum: 1000000)"),
  ),
  summary_max_bytes: Schema.optional(
    bounded(MAX_BODY_BYTES, "Maximum bytes of one compaction summary (default: 98304; maximum: 67108864)"),
  ),
  active_max_tokens: Schema.optional(
    bounded(MAX_TOKENS, "Maximum tokens kept active per compaction range (default: 80000; maximum: 10000000)"),
  ),
  active_max_bytes: Schema.optional(
    bounded(MAX_ACTIVE_BYTES, "Maximum bytes kept active per compaction range (default: 524288; maximum: 268435456)"),
  ),
  max_ranges: Schema.optional(bounded(1024, "Maximum compaction ranges per session (default: 8; maximum: 1024)")),
  max_blocks: Schema.optional(
    bounded(16_384, "Maximum blocks scanned per compaction pass (default: 128; maximum: 16384)"),
  ),
  max_messages: Schema.optional(
    bounded(65_536, "Maximum messages considered per compaction pass (default: 4096; maximum: 65536)"),
  ),
  read_max_tokens: Schema.optional(
    bounded(1_000_000, "Maximum tokens read from one retained message (default: 2048; maximum: 1000000)"),
  ),
  read_max_bytes: Schema.optional(
    bounded(MAX_BODY_BYTES, "Maximum bytes read from one retained message (default: 8192; maximum: 67108864)"),
  ),
  search_scan_bytes: Schema.optional(
    bounded(
      MAX_SCAN_BYTES,
      "Maximum bytes scanned when searching retained history (default: 4194304; maximum: 1073741824)",
    ),
  ),
  search_max_results: Schema.optional(
    bounded(1000, "Maximum results returned when searching retained history (default: 10; maximum: 1000)"),
  ),
  protect_user_messages: Schema.optional(Schema.Boolean).annotate({
    description: "Keep user messages verbatim during native compaction (default: true)",
  }),
  protected_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description:
      "Tool names whose outputs native compaction never drops (default: [task, task_status, skill, todowrite, todoread])",
  }),
})

// 261010 Red target <= reminder <= trigger 是压缩预算的不变量。只改其中一个字段
// 也要和另外两个的**生效值**（缺省值参与）比较，否则 "target_tokens: 300000" 这种
// 配错会靠默认 trigger=250000 悄悄成立，触发点反而低于目标点。
const orderedBudget = Schema.makeFilter<Schema.Schema.Type<typeof Fields>>((data) => {
  const trigger = data.trigger_tokens ?? TRIGGER_DEFAULT
  const target = data.target_tokens ?? TARGET_DEFAULT
  const reminder = data.reminder_tokens ?? REMINDER_DEFAULT
  if (target > reminder) return `target_tokens (${target}) must not exceed reminder_tokens (${reminder})`
  if (reminder > trigger) return `reminder_tokens (${reminder}) must not exceed trigger_tokens (${trigger})`
  const soft = data.soft_ratio ?? 0.72
  const prune = data.prune_ratio ?? 0.88
  if (!(0 < soft && soft < prune && prune < 1))
    return `context warning ratios must satisfy 0 < soft_ratio (${soft}) < prune_ratio (${prune}) < 1`
  return undefined
})

export const Info = Fields.check(orderedBudget).annotate({ identifier: "NativeCompactionConfig" })
export type Info = typeof Info.Type

export type Spec = {
  readonly enabled: boolean
  readonly triggerTokens: number
  readonly targetTokens: number
  readonly reminderTokens: number
  readonly softRatio: number
  readonly pruneRatio: number
  readonly summaryMaxTokens: number
  readonly summaryMaxBytes: number
  readonly activeMaxTokens: number
  readonly activeMaxBytes: number
  readonly maxRanges: number
  readonly maxBlocks: number
  readonly maxMessages: number
  readonly readMaxTokens: number
  readonly readMaxBytes: number
  readonly searchScanBytes: number
  readonly searchMaxResults: number
  readonly protectUserMessages: boolean
  readonly protectedTools: readonly string[]
}

/**
 * 配置边界：未知输入先过 schema（顺序错误在这里抛，早于下面的模型夹取），再落默认值。
 *
 * usableTokens 是模型可用窗口（overflow.usable）：大于 0 且 trigger 超过它时，trigger
 * 夹到窗口大小，target/reminder 按**配置里的比例**同步缩小——小模型因此拿到同一形状
 * 的预算而不是一个够不着的触发点。窗口未知（<=0）时一个数都不动。
 */
export function resolve(value?: Info, usableTokens?: number): Spec {
  const cfg = Schema.decodeUnknownSync(Info)(value ?? {})
  const spec: Spec = {
    enabled: cfg.enabled ?? false,
    triggerTokens: cfg.trigger_tokens ?? TRIGGER_DEFAULT,
    targetTokens: cfg.target_tokens ?? TARGET_DEFAULT,
    reminderTokens: cfg.reminder_tokens ?? REMINDER_DEFAULT,
    softRatio: cfg.soft_ratio ?? 0.72,
    pruneRatio: cfg.prune_ratio ?? 0.88,
    summaryMaxTokens: cfg.summary_max_tokens ?? 16_000,
    summaryMaxBytes: cfg.summary_max_bytes ?? 98_304,
    activeMaxTokens: cfg.active_max_tokens ?? 80_000,
    activeMaxBytes: cfg.active_max_bytes ?? 524_288,
    maxRanges: cfg.max_ranges ?? 8,
    maxBlocks: cfg.max_blocks ?? 128,
    maxMessages: cfg.max_messages ?? 4096,
    readMaxTokens: cfg.read_max_tokens ?? 2048,
    readMaxBytes: cfg.read_max_bytes ?? 8192,
    searchScanBytes: cfg.search_scan_bytes ?? 4_194_304,
    searchMaxResults: cfg.search_max_results ?? 10,
    protectUserMessages: cfg.protect_user_messages ?? true,
    protectedTools: cfg.protected_tools ?? ["task", "task_status", "skill", "todowrite", "todoread"],
  }
  const usable = usableTokens !== undefined && usableTokens > 0 ? usableTokens : 0
  if (usable <= 0 || spec.triggerTokens <= usable) return spec
  const scale = (tokens: number) => Math.floor((tokens * usable) / spec.triggerTokens)
  return {
    ...spec,
    triggerTokens: usable,
    targetTokens: scale(spec.targetTokens),
    reminderTokens: scale(spec.reminderTokens),
  }
}
