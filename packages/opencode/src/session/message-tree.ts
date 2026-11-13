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
 * 树模式走链，悬空指针与环都按「路径到此为止」终止——步数上界就是消息数，
 * 不需要额外防环结构。输入必须是 MessageV2.page 的规范序（time_created, id 升序）。
 *
 * 走链方向二选一：
 * - leafID（首选）：从会话级叶指针沿 parentID 反向收集再反转。与 prompt 咽喉点
 *   的 newest-first 流式读同构，是唯一能与压缩 early-stop 组合的走法；发生过
 *   重根的会话必须走这条（时序探测拿错根）。
 * - 无 leafID：正向从 root 走 selectedChildID。root 按时序探测（第一条无树父的
 *   user）——只适用于未重根会话。
 */
export function visiblePath<T extends WithInfo>(
  messages: T[],
  pointer?: { leafID?: MessageID; rootID?: MessageID },
): T[] {
  if (messages.length === 0 || !hasExplicitBranches(messages)) return messages
  const byId = new Map(messages.map((m) => [m.info.id, m]))
  if (pointer?.leafID) {
    const path: T[] = []
    let node = byId.get(pointer.leafID)
    for (let i = 0; i < messages.length && node; i++) {
      path.push(node)
      node = node.info.parentID ? byId.get(node.info.parentID) : undefined
    }
    return path.reverse()
  }
  const root = (pointer?.rootID && byId.get(pointer.rootID)) ||
    messages.find((m) => m.info.role === "user" && m.info.parentID === undefined) ||
    messages[0]!
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

// ── Phase 2 写入侧 ────────────────────────────────────────────────────────────
//
// 写入契约：物化 → 落分支/切分支，全部在服务端单事务语义内完成（读侧照
// visiblePath 消费）。三个纯函数只计算「哪些 info 要写」，持久化由调用方
// 逐条 updateMessage 完成——函数不接触 IO，测试不需要数据库。

/**
 * 物化：把线性历史的树指针补成显式字段（就地变更，写入方持有本轮独占的
 * 规范序读出）。只返回确实发生了变化的节点（调用方据此持久化）；已物化的
 * 会话返回空数组。混合状态（部分显式）按契约不允许出现——那是写入方漏
 * 物化的 bug，这里不做静默修补。
 * 输入必须是规范序（time_created, id 升序）。
 */
export function materialize<T extends WithInfo>(messages: T[]): T[] {
  if (messages.length === 0 || hasExplicitBranches(messages)) return []
  const changed: T[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const next = messages[i + 1]?.info.id
    let touched = false
    if (message.info.role === "user") {
      if (i > 0) {
        message.info.parentID = messages[i - 1]!.info.id
        touched = true
      }
      if (next) {
        message.info.selectedChildID = next
        touched = true
      }
    } else if (next) {
      message.info.selectedChildID = next
      touched = true
    }
    if (touched) changed.push(message)
  }
  return changed
}

export type BranchWrite<T extends WithInfo> = {
  /** 要持久化的节点：改选指针的父节点 + 携带新指针的新消息（或空） */
  changed: T[]
  /** 重根场景（编辑首条消息 / 切换根版本）的新 root；调用方持久化到会话级指针 */
  newRootID?: MessageID
}

/**
 * 落分支：把 newMessages（树分支的整条消息链，首条通常是改写后的 user 提问）
 * 挂到 parentID 之下，并把父节点的 selectedChildID 指向新链首条——原分支
 * 原样保留，切回 = 把父节点指针改回去（selectVersion）。
 * parentID 传 undefined 表示重根（编辑会话第一条消息）：新链成为新 root，
 * 调用方须把返回的 newRootID 持久化到会话级 root 指针。
 * messages 必须是已物化的规范序全量；newMessages 的 id 由调用方预先分配
 * （MessageID.ascending()），本函数只负责接线。父节点不存在是调用方 bug，
 * 显式抛错而不是静默吞掉。
 */
export function appendBranch<T extends WithInfo>(
  messages: T[],
  parentID: MessageID | undefined,
  newMessages: T[],
): BranchWrite<T> {
  const first = newMessages[0]
  if (!first) return { changed: [] }
  const changed: T[] = []
  for (let i = 0; i < newMessages.length; i++) {
    const node = newMessages[i]!
    const info = node.info
    if (info.role === "user") {
      const parent = i === 0 ? parentID : newMessages[i - 1]!.info.id
      if (parent) info.parentID = parent
      else delete info.parentID
    }
    const next = newMessages[i + 1]?.info.id
    if (next) info.selectedChildID = next
    else delete info.selectedChildID
    changed.push(node)
  }
  if (parentID) {
    const parent = messages.find((m) => m.info.id === parentID)
    if (!parent) throw new Error(`appendBranch: parent message ${parentID} not found in session`)
    parent.info.selectedChildID = first.info.id
    changed.unshift(parent)
    return { changed }
  }
  return { changed, newRootID: first.info.id }
}

/**
 * 切分支：把 messageID 的父节点选中指针改指 messageID，恢复该版本及其已选
 * 后续。仅允许切换「当前可见路径上某节点的兄弟版本」（demo 同规则）——目标
 * 的父节点不在可见路径上时切换没有可见效果，拒绝而不是静默空转。
 * 根版本的切换（parentID 为 undefined 的兄弟）返回 newRootID，调用方更新
 * 会话级 root 指针。不满足条件返回空 changed 且无 newRootID。
 */
export function selectVersion<T extends WithInfo>(
  messages: T[],
  messageID: MessageID,
  rootID?: MessageID,
): BranchWrite<T> {
  const target = messages.find((m) => m.info.id === messageID)
  if (!target || !hasExplicitBranches(messages)) return { changed: [] }
  const parentID = target.info.parentID
  // 根版本的切换（target 自身无树父）：任何根兄弟都可成为新 root
  if (parentID === undefined) return { changed: [], newRootID: messageID }
  const path = visiblePath(messages, { rootID })
  if (!path.some((m) => m.info.id === parentID)) return { changed: [] }
  const parent = messages.find((m) => m.info.id === parentID)
  if (!parent) throw new Error(`selectVersion: parent message ${parentID} not found in session`)
  parent.info.selectedChildID = messageID
  return { changed: [parent] }
}
