// 261114 Red 消息树分支 Phase 1（决策：docs/notes/proposed/feature/2026-11-14-message-tree-branching.md）。
// 数据模型取自 DeepSeek chat-demo 的 branches.ts：每条消息带 parentID（线性序上的前一条，
// assistant 侧即已有的「触发的 user」字段）与 selectedChildID（当前选中的下一条），
// 可见路径 = 从 root 沿 selectedChildID 走出的链——展示与请求上下文共用这一条路径。
//
// Phase 1 只读不写，读侧零变更、零派生：会话要么完全线性（无任何显式树字段，存量
// 数据全如此，原序即可见路径），要么完全物化（写入方在首次落分支时把整条可见路径
// 的指针补成显式字段——物化是 Phase 2 的写入契约，不做读时推导）。不做读时派生
// 的原因：派生字段会泄漏进「规范读 vs 原始读」的对比（compaction 测试实测撞上），
// 并可能随 info 回写落库，把线性会话误判成树模式——物化义务交给写入方后这些
// 一致性问题整体消失。
//
// 独立成模块的缘由与 summary-complete.ts 相同：树语义的纯函数要让测试与后续
// Phase 2（appendBranch / selectVersion / 物化）复用，不必拖上 message-v2 的模型依赖。

import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

type WithInfo = { info: MessageV2.Info }

/**
 * 会话是否已物化树指针（存在任一显式树字段）。这也是 Phase 2 写入方的判定入口：
 * 首次落分支前必须先按当前可见路径物化整条链（线性历史 → 显式指针），物化后
 * 所有消息都必须带全 parentID / selectedChildID，不允许半物化状态。
 */
export function hasExplicitBranches(messages: readonly WithInfo[]): boolean {
  return messages.some((m) =>
    m.info.role === "user"
      ? m.info.parentID !== undefined || m.info.selectedChildID !== undefined
      : m.info.selectedChildID !== undefined,
  )
}

/**
 * 可见路径：线性历史（无显式树字段）原序返回（同一数组引用，零分配零变更）；
 * 树模式从 root（时序上第一条无树父的 user）沿 selectedChildID 严格走链，悬空
 * 指针与环都按「路径到此为止」终止——步数上界就是消息数，不需要额外防环结构。
 * 输入必须是 MessageV2.page 的规范序（time_created, id 升序）。
 */
export function visiblePath<T extends WithInfo>(messages: T[]): T[] {
  if (messages.length === 0 || !hasExplicitBranches(messages)) return messages
  const byId = new Map(messages.map((m) => [m.info.id, m]))
  const root =
    messages.find((m) => m.info.role === "user" && m.info.parentID === undefined) ?? messages[0]!
  const path: T[] = []
  let node: T | undefined = root
  for (let i = 0; i < messages.length; i++) {
    if (!node) break
    path.push(node)
    const next: MessageID | undefined = node.info.selectedChildID
    node = next ? byId.get(next) : undefined
  }
  return path
}
