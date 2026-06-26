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

export function isOverflow(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
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
