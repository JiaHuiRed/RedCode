import { popularProviders } from "@/hooks/use-providers"

export type RecentModelItem = { recent?: boolean }

/**
 * 261121 Red 模型列表「最近使用」前排的共享逻辑，Code 会话选择器（dialog-select-model）
 * 与 Chat 首页选择器（chat-composer-tools）共用。最近条目须由调用方先解析并通过可见性
 * 过滤，这里只负责与主列表去重合并、让最近条目排在前排不重复出现。key 是 provider+model
 * 的稳定去重键——两侧模型对象形状不同（Code 是嵌套 provider 对象），由调用方给出。
 */
export function mergeRecentItems<T>(recents: T[], models: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of recents) {
    const id = key(item)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(item)
  }
  return [...out, ...models.filter((model) => !seen.has(key(model)))]
}

/** 分组排序：最近使用恒排最前，其余按常用供应商清单的顺序排。 */
export function sortGroupsRecentFirst<T extends RecentModelItem>(
  providerID: (item: T) => string,
): (a: { items: T[] }, b: { items: T[] }) => number {
  return (a, b) => {
    const aRecent = a.items[0]?.recent === true
    const bRecent = b.items[0]?.recent === true
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    const aID = providerID(a.items[0]!)
    const bID = providerID(b.items[0]!)
    if (popularProviders.includes(aID) && !popularProviders.includes(bID)) return -1
    if (!popularProviders.includes(aID) && popularProviders.includes(bID)) return 1
    return popularProviders.indexOf(aID) - popularProviders.indexOf(bID)
  }
}

/**
 * 261121 Red 供应商飞出层的「最近使用」分组：模型最近记录逐条取供应商 ID，去重保序。
 * 解析不到的条目（模型已下线等）静默跳过——recency 推导不该比主列表更响。
 */
export function recentProviderIDs<T>(recent: readonly (T | undefined)[], providerID: (item: T) => string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of recent) {
    if (!item) continue
    const id = providerID(item)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 供应商飞出层的「全部供应商」排序：常用清单在前列表内保持相对顺序，其余按名称。 */
export function popularFirstProviders<P extends { id: string; name: string }>(providers: readonly P[]): P[] {
  const rank = (id: string) => {
    const index = popularProviders.indexOf(id)
    return index === -1 ? popularProviders.length : index
  }
  return [...providers].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
}
