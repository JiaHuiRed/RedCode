import type { OpenAIResponseIncludable } from "../protocols/utils/openai-options"
import type { ProviderOptions, ReasoningEffort, TextVerbosity } from "../schema"
import { mergeProviderOptions } from "../schema"

export interface OpenAIOptionsInput {
  readonly [key: string]: unknown
  readonly store?: boolean
  readonly promptCacheKey?: string
  readonly reasoningEffort?: ReasoningEffort
  readonly reasoningSummary?: "auto"
  /** Explicit Responses `include` list. Wins outright over `includeEncryptedReasoning`. */
  readonly include?: ReadonlyArray<OpenAIResponseIncludable>
  /** Shorthand for `include: ["reasoning.encrypted_content"]`, used only when `include` is absent. */
  readonly includeEncryptedReasoning?: boolean
  readonly textVerbosity?: TextVerbosity
}

export type OpenAIProviderOptionsInput = ProviderOptions & {
  readonly openai?: OpenAIOptionsInput
}

const definedEntries = (input: Record<string, unknown>) =>
  Object.entries(input).filter((entry) => entry[1] !== undefined)

const openAIProviderOptions = (options: OpenAIOptionsInput | undefined): ProviderOptions | undefined => {
  const openai = Object.fromEntries(
    definedEntries({
      store: options?.store,
      promptCacheKey: options?.promptCacheKey,
      reasoningEffort: options?.reasoningEffort,
      reasoningSummary: options?.reasoningSummary,
      include: options?.include,
      includeEncryptedReasoning: options?.includeEncryptedReasoning,
      textVerbosity: options?.textVerbosity,
    }),
  )
  if (Object.keys(openai).length === 0) return undefined
  return { openai }
}

export const gpt5DefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean } = {},
): ProviderOptions | undefined => {
  const id = modelID.toLowerCase()
  if (!id.includes("gpt-5") || id.includes("gpt-5-chat") || id.includes("gpt-5-pro")) return undefined
  return openAIProviderOptions({
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    // `openAIDefaultOptions` pins GPT-5 to `store: false`, so the server keeps
    // no reasoning state between turns. Without the encrypted blob coming back
    // a continuation drops its own reasoning items on the floor, so ask for it
    // by default. Callers opt out with `includeEncryptedReasoning: false`, or
    // by passing their own `include` list. The Chat route has no `include`
    // field and ignores this, the same way it already ignores
    // `reasoningSummary` and `textVerbosity`.
    includeEncryptedReasoning: true,
    textVerbosity:
      options.textVerbosity === true && id.includes("gpt-5.") && !id.includes("codex") && !id.includes("-chat")
        ? "low"
        : undefined,
  })
}

export const openAIDefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean } = {},
): ProviderOptions | undefined =>
  mergeProviderOptions(openAIProviderOptions({ store: false }), gpt5DefaultOptions(modelID, options))

export const withOpenAIOptions = <Options extends { readonly providerOptions?: OpenAIProviderOptionsInput }>(
  modelID: string,
  options: Options,
  defaults: { readonly textVerbosity?: boolean } = {},
): Omit<Options, "providerOptions"> & { readonly providerOptions?: ProviderOptions } => {
  return {
    ...options,
    providerOptions: mergeProviderOptions(openAIDefaultOptions(modelID, defaults), options.providerOptions),
  }
}

export * as OpenAIProviderOptions from "./openai-options"
