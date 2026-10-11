import type { DisposeCheck, EvictPlan } from "./types"

export function pickDirectoriesToEvict(input: EvictPlan) {
  const sorted = input.stores
    .filter((dir) => !input.pins.has(dir))
    .slice()
    .sort((a, b) => (input.state.get(a)?.lastAccessAt ?? 0) - (input.state.get(b)?.lastAccessAt ?? 0))
  const output: string[] = []
  for (const dir of sorted) {
    const last = input.state.get(dir)?.lastAccessAt
    // 260910 Red: 无 lifecycle 记录 ≠ 空闲 20 分钟。原写法 `?? 0` 让任何没被 markKey
    // 记过的 store（ensureChild 建了 store，但 pinForOwner 在 owner 相同时提前 return，
    // 于是从未 pin/mark）恒被判 idle —— 每次 runEviction 都把它们整体淘汰并触发一发
    // /instance/dispose；视图随即重建 store，下一轮再被淘汰。项目数接近 MAX_DIR_STORES
    // 时这个循环会自持：实测 2854 次 dispose，Chromium 报 net::ERR_INSUFFICIENT_RESOURCES，
    // 之后会话列表与消息请求全部 Failed to fetch（GUI 三症状：历史会话空白、工作区会话
    // 加载失败、卡片闪动）。无记录的目录不参与淘汰，等它真正被 mark/pin 过再按 idle 处理。
    if (last === undefined) continue
    // 261011 Red: 删掉 overflow 补淘活跃目录的路径。首页 Kanban 对全部项目建 store，
    // 项目数恒超目录上限，淘活跃目录会被视图立即重建——store 淘-建死循环，且每轮对
    // 同批目录重发 /instance/dispose（261011 现场：13 个目录每 200ms 一轮，打满
    // renderer→sidecar 的 HTTP/1.1 6 槽，全站请求 Failed to fetch）。活跃目录的
    // 「硬上限」本就不可执行（执行 = 空转），收敛改由 idle TTL 承担：闲置满 ttl
    // 的目录照旧回收，不再有第二个淘汰来源。
    if (input.now - last < input.ttl) continue
    output.push(dir)
  }
  return output
}

export function canDisposeDirectory(input: DisposeCheck) {
  if (!input.directory) return false
  if (!input.hasStore) return false
  if (input.pinned) return false
  if (input.booting) return false
  if (input.loadingSessions) return false
  return true
}
