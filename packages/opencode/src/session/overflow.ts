import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: Config.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

// 260729 Red 分级阈值（取自 DeepSeek-Reasonix 的 compact.go）。
//
// 原先只有一个二值判定：没溢出什么都不做，一溢出就直接摘要压缩。问题是摘要压缩是
// **前缀缓存重置点** —— 它重写历史、把整个 prefix cache 打掉，还要付一次模型调用。
// 单阈值意味着这件事总是来得很突然，且来的时候已经没有便宜手段可用了。
//
// 分成三档，让廉价手段先上：
//   soft(0.6)   只记一条提示，**明确不动前缀** —— 这里做任何重写都是白白炸掉缓存
//   prune(0.8)  裁剪陈旧工具输出。纯本地改写，不花钱、不调模型
//   compact     真正的摘要压缩。触发点与改造前完全一致（count >= usable），不动它，
//               避免改变既有的压缩时机
//
// 比例是相对 usable() 而非整个 context window：usable 已经扣掉了输出预留，
// 相对它算才是"离真正压缩还有多远"。
export const RATIOS = { soft: 0.6, prune: 0.8 } as const

export type Level = "ok" | "soft" | "prune" | "compact"

/** 当前用量落在哪一档。compact 档与 isOverflow 完全等价。 */
export function level(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}): Level {
  if (isOverflow(input)) return "compact"
  if (input.cfg.compaction?.auto === false) return "ok"
  const limit = usable(input)
  if (limit <= 0) return "ok"
  const count = tokenCount(input.tokens)
  if (count >= limit * RATIOS.prune) return "prune"
  if (count >= limit * RATIOS.soft) return "soft"
  return "ok"
}

function tokenCount(tokens: MessageV2.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

export function isOverflow(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false

  const count = tokenCount(input.tokens)
  // 260612 Red hard ceiling: if threshold is set, trigger compaction at that point
  // regardless of model's (often inflated) declared context limit.
  // This replaces DCP's auto-compress role after DCP was removed.
  // 260626 Red threshold must be checked BEFORE the context===0 guard: custom
  // providers (no models.dev entry, no config-declared limit) resolve to
  // context:0 (provider.ts), which would otherwise disable compaction entirely
  // and let DCP nudge forever without ever triggering. Honor the hard ceiling
  // even when the model's context window is unknown.
  const threshold = input.cfg.compaction?.threshold
  if (threshold && count >= threshold) return true

  if (input.model.limit.context === 0) return false
  return count >= usable(input)
}
