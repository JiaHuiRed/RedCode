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
  return {
    ready,
    all: () => providers().all,
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
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
