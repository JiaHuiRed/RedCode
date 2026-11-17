// 261006 Red 从 agent.ts 单体拆出（上游 acp/config-option.ts 的对应物）：ACP
// initialize/config-option 用到的模型列表、variant 解析与 SessionConfigOption 构造，
// 全部是 (providers, modelId) → options 的纯函数，不依赖运行时服务。

import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"

export type ModeOption = { id: string; name: string; description?: string }
export type ModelOption = { modelId: string; name: string }

export const DEFAULT_VARIANT_VALUE = "default"

export function sortProvidersByName<T extends { name: string }>(providers: T[]): T[] {
  return [...providers].sort((a, b) => {
    const nameA = a.name.toLowerCase()
    const nameB = b.name.toLowerCase()
    if (nameA < nameB) return -1
    if (nameA > nameB) return 1
    return 0
  })
}

export function modelVariantsFromProviders(
  providers: Array<{ id: string; models: Record<string, { variants?: Record<string, any> }> }>,
  model: { providerID: ProviderID; modelID: ModelID },
): string[] {
  const provider = providers.find((entry) => entry.id === model.providerID)
  if (!provider) return []
  const modelInfo = provider.models[model.modelID]
  if (!modelInfo?.variants) return []
  return Object.keys(modelInfo.variants)
}

export function buildAvailableModels(
  providers: Array<{ id: string; name: string; models: Record<string, any> }>,
  options: { includeVariants?: boolean } = {},
): ModelOption[] {
  const includeVariants = options.includeVariants ?? false
  return providers.flatMap((provider) => {
    const unsorted: Array<{ id: string; name: string; variants?: Record<string, any> }> = Object.values(provider.models)
    const models = Provider.sort(unsorted)
    return models.flatMap((model) => {
      const base: ModelOption = {
        modelId: `${provider.id}/${model.id}`,
        name: `${provider.name}/${model.name}`,
      }
      if (!includeVariants || !model.variants) return [base]
      const variants = Object.keys(model.variants).filter((variant) => variant !== DEFAULT_VARIANT_VALUE)
      const variantOptions = variants.map((variant) => ({
        modelId: `${provider.id}/${model.id}/${variant}`,
        name: `${provider.name}/${model.name} (${variant})`,
      }))
      return [base, ...variantOptions]
    })
  })
}

export function formatModelIdWithVariant(
  model: { providerID: ProviderID; modelID: ModelID },
  variant: string | undefined,
  availableVariants: string[],
  includeVariant: boolean,
) {
  const base = `${model.providerID}/${model.modelID}`
  if (!includeVariant || availableVariants.length === 0) return base
  const selectedVariant =
    variant && availableVariants.includes(variant)
      ? variant
      : availableVariants.includes(DEFAULT_VARIANT_VALUE)
        ? DEFAULT_VARIANT_VALUE
        : availableVariants[0]
  return `${base}/${selectedVariant}`
}

export function buildVariantMeta(input: {
  model: { providerID: ProviderID; modelID: ModelID }
  variant?: string
  availableVariants: string[]
}) {
  return {
    redcode: {
      modelId: `${input.model.providerID}/${input.model.modelID}`,
      variant: input.variant ?? null,
      availableVariants: input.availableVariants,
    },
  }
}

export function parseModelSelection(
  modelId: string,
  providers: Array<{ id: string; models: Record<string, { variants?: Record<string, any> }> }>,
): { model: { providerID: ProviderID; modelID: ModelID }; variant?: string } {
  const parsed = Provider.parseModel(modelId)
  const provider = providers.find((p) => p.id === parsed.providerID)
  if (!provider) {
    return { model: parsed, variant: undefined }
  }

  // Check if modelID exists directly
  if (provider.models[parsed.modelID]) {
    return { model: parsed, variant: undefined }
  }

  // Try to extract variant from end of modelID (e.g., "claude-sonnet-4/high" -> model: "claude-sonnet-4", variant: "high")
  const segments = parsed.modelID.split("/")
  if (segments.length > 1) {
    const candidateVariant = segments[segments.length - 1]
    const baseModelId = segments.slice(0, -1).join("/")
    const baseModelInfo = provider.models[baseModelId]
    if (baseModelInfo?.variants && candidateVariant in baseModelInfo.variants) {
      return {
        model: { providerID: parsed.providerID, modelID: ModelID.make(baseModelId) },
        variant: candidateVariant,
      }
    }
  }

  return { model: parsed, variant: undefined }
}

export function buildConfigOptions(input: {
  currentModelId: string
  availableModels: ModelOption[]
  currentVariant?: string
  availableVariants?: string[]
  modes?: { availableModes: ModeOption[]; currentModeId: string } | undefined
}): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: input.currentModelId,
      options: input.availableModels.map((m) => ({ value: m.modelId, name: m.name })),
    },
  ]
  if (input.availableVariants?.length) {
    options.push({
      id: "effort",
      name: "Effort",
      description: "Available effort levels for this model",
      category: "thought_level",
      type: "select",
      currentValue:
        input.currentVariant && input.availableVariants.includes(input.currentVariant)
          ? input.currentVariant
          : input.availableVariants.includes(DEFAULT_VARIANT_VALUE)
            ? DEFAULT_VARIANT_VALUE
            : input.availableVariants[0],
      options: input.availableVariants.map((variant) => ({ value: variant, name: formatVariantName(variant) })),
    })
  }
  if (input.modes) {
    options.push({
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: input.modes.currentModeId,
      options: input.modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name,
        ...(m.description ? { description: m.description } : {}),
      })),
    })
  }
  return options
}

export function formatVariantName(variant: string) {
  return variant
    .split(/[_-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ")
}

export * as ModelOptions from "./model-options"
