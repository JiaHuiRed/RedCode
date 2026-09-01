import type { Agent, Project, ProviderListResponse } from "@redcode-ai/sdk/v2/client"
import { NormalizedProviderListResponse } from "@redcode-ai/ui/context"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

export function normalizeAgentList(input: unknown): Agent[] {
  if (Array.isArray(input)) return input.filter(isAgent)
  if (isAgent(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(isAgent)
}

function toProviderMap(list: ProviderListResponse["all"]) {
  return new Map(
    list.map(
      (provider) =>
        [
          provider.id,
          {
            ...provider,
            models: Object.fromEntries(
              Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
            ),
          },
        ] as const,
    ),
  )
}

export function normalizeProviderList(input: ProviderListResponse): NormalizedProviderListResponse {
  return {
    ...input,
    all: toProviderMap(input.all),
  }
}

/**
 * `/config/providers` 的结果规范成与 `/provider` 相同的形状。
 *
 * 260901 cc 关键路径上的 provider 数据改走这个端点。两个端点的**数据源是同一个**
 * （`Provider.Service.list()` → InstanceState 里缓存的 `state.providers`），区别只在
 * `/provider` 还会把整个 models.dev 目录并进来：实测 215 厂商 / 7378 模型 / 5879KB / 每次
 * 630-915ms（缓存不了，`toPublicInfo` 是 `JSON.parse(JSON.stringify())`，每请求重算一遍），
 * 而 `/config/providers` 是 14 厂商 / 120 模型 / 105KB / 热态 16-20ms。TUI 一直走的是后者
 * （cli/cmd/run/runtime.boot.ts:120，变量名就叫 connected），GUI 走前者——这是两边体感差距的来源。
 *
 * `connected` 由 id 推出：两个端点这一项的取值集合完全相同（`/provider` 的 connected 就是
 * `Object.keys(providerSvc.list())`），所以推导不丢信息。
 *
 * 未连接的厂商（连接对话框、popular 列表、老会话里已移除厂商的模型报价）由目录查询在空闲时
 * 补上，见 [loadProviderCatalogQuery]。
 */
export function normalizeConfigProviderList(input: {
  providers: ProviderListResponse["all"]
  default: ProviderListResponse["default"]
}): NormalizedProviderListResponse {
  const all = toProviderMap(input.providers)
  return {
    all,
    default: input.default,
    connected: Array.from(all.keys()),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}
