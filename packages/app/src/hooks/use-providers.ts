import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createMemo } from "solid-js"

export const popularProviders = [
  "redcode",
  "redcode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

export function useProviders() {
  const globalSync = useServerSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.provider_ready) return projectStore.provider
    }
    return globalSync.data.provider
  }
  // 260529 Red provider 数据加载完成前阻止提交，避免误触发"请选择智能体和模型"
  const ready = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (!projectStore.provider_ready) return false
    }
    // 260605 Red 只检查 all.size（provider 列表是否已加载），不检查 connected.length。
    // connected 是实时连接状态，受网络/代理影响，若所有 provider 都连不上会导致 ready() 永假，
    // submit gate 静默卡死。connected 为空的正向提示由 submit.ts 的 currentModel 空值检查
    // 负责（弹 toast"请选择智能体和模型"），不需要在 ready 层阻塞。
    return globalSync.data.provider.all.size > 0
  }
  // 260901 cc all() = 已连接 ∪ 全量目录，已连接优先（它带 source/key 这些运行时字段）。
  //   已连接来自 /config/providers（关键路径，105KB，热态 16ms），目录来自 /provider
  //   （5.7MB，空闲时拉一次，见 loadProviderCatalogQuery）。目录没到之前 all() 就是已连接那份
  //   —— 界面上唯一的差别是「还没连的厂商」暂时不出现在连接对话框里，那几处本来就是用户点开才看。
  //   必须是 memo：all() 在 session-context-metrics / home-stats 这些地方每次求值都会被展开成
  //   数组，现算现合并等于每帧新建一个 215 条的 Map。
  const catalog = () => globalSync.data.provider_catalog.all
  const merged = createMemo(() => {
    const connected = providers().all
    const full = catalog()
    if (full.size === 0) return connected
    if (connected.size === 0) return full
    return new Map([...full, ...connected])
  })
  return {
    ready,
    all: merged,
    default: () => providers().default,
    popular: () =>
      pipe(
        merged(),
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "redcode" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]
    },
  }
}
