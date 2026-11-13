import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import {
  appendBranch,
  hasExplicitBranches,
  materialize,
  selectVersion,
  visiblePath,
} from "../../src/session/message-tree"

// 261114 Red 消息树分支 Phase 1 纯函数用例。读侧零变更：线性历史原序返回、
// 不派生任何字段；物化指针（Phase 2 写入契约）的会话走严格 selectedChildID 链。
// DB 级等价性用例在 messages-pagination.test.ts（复用其 harness）。

type Node = { info: MessageV2.Info }

let seq = 0
/** 线性历史（无显式树字段）的 user；over 用于手工注入显式树字段模拟 Phase 2 写入形态 */
const user = (over: Partial<MessageV2.Info> = {}): Node => ({
  info: {
    id: MessageID.ascending(),
    role: "user",
    time: { created: ++seq },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    ...over,
  } as unknown as MessageV2.Info,
})
const assistant = (parentID: MessageID, over: Partial<MessageV2.Info> = {}): Node => ({
  info: {
    id: MessageID.ascending(),
    role: "assistant",
    time: { created: ++seq },
    parentID,
    modelID: "test",
    providerID: "test",
    ...over,
  } as unknown as MessageV2.Info,
})
/** 树模式里的后续 user：物化后除 root 外都带 parentID */
const treeUser = (parentID: MessageID, over: Partial<MessageV2.Info> = {}): Node =>
  user({ parentID, ...over })
const ids = (nodes: Node[]) => nodes.map((n) => n.info.id)
const setChild = (node: Node, child: Node) => {
  ;(node.info as { selectedChildID?: MessageID }).selectedChildID = child.info.id
}

describe("session.message-tree.hasExplicitBranches", () => {
  test("branchless history is not tree-shaped", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    expect(hasExplicitBranches([u1, a1])).toBe(false)
  })

  test("any explicit branch field marks the session tree-shaped", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const a2 = assistant(u1.info.id as MessageID)
    setChild(u1, a2)
    expect(hasExplicitBranches([u1, a1, a2])).toBe(true)
    expect(hasExplicitBranches([])).toBe(false)
  })
})

describe("session.message-tree.visiblePath", () => {
  test("branchless history returns the input order unchanged (same reference, zero mutation)", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u2 = user()
    const a2 = assistant(u2.info.id as MessageID)
    const nodes = [u1, a1, u2, a2]
    const result = visiblePath(nodes)
    // 同一引用 + 元素不变：不派生、不落任何树字段
    expect(result).toBe(nodes)
    expect(u1.info).not.toHaveProperty("selectedChildID")
    expect(a1.info).not.toHaveProperty("selectedChildID")
    expect(u2.info).not.toHaveProperty("parentID")
  })

  test("selectedChildID picks the visible branch and hides the abandoned sibling", () => {
    // 编辑重发形态：u1 下有 a1（旧回答）与 a2（重新生成），当前选中 a2
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const a2 = assistant(u1.info.id as MessageID)
    setChild(u1, a2)
    expect(visiblePath([u1, a1, a2]).map((n) => n.info.id)).toStrictEqual(ids([u1, a2]))
  })

  test("switching the pointer back restores the old branch", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const a2 = assistant(u1.info.id as MessageID)
    setChild(u1, a1)
    expect(visiblePath([u1, a1, a2]).map((n) => n.info.id)).toStrictEqual(ids([u1, a1]))
  })

  test("deep branch: pointer chain decides the path, not array position", () => {
    // u1 → a1 下有两条后续 u2 / u2b，选中 u2b；数组序是创建序 [u1, a1, u2, a2, u2b]
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u2 = treeUser(a1.info.id as MessageID)
    const a2 = assistant(u2.info.id as MessageID)
    const u2b = treeUser(a1.info.id as MessageID)
    setChild(u1, a1)
    setChild(a1, u2b)
    expect(visiblePath([u1, a1, u2, a2, u2b]).map((n) => n.info.id)).toStrictEqual(ids([u1, a1, u2b]))
  })

  test("dangling selectedChildID ends the path at that node", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    ;(u1.info as { selectedChildID?: MessageID }).selectedChildID =
      "msg_does_not_exist" as unknown as MessageID
    expect(visiblePath([u1, a1]).map((n) => n.info.id)).toStrictEqual(ids([u1]))
  })

  test("a cycle in the pointer chain terminates at the message-count bound", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    setChild(u1, a1)
    setChild(a1, u1)
    const path = visiblePath([u1, a1])
    expect(path.length).toBeLessThanOrEqual(2)
    expect(path[0]!.info.id).toBe(u1.info.id)
  })

  test("empty history is a no-op", () => {
    expect(visiblePath([])).toStrictEqual([])
  })
})

describe("session.message-tree.materialize", () => {
  test("linear history gains explicit pointers; only touched nodes are reported", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u2 = user()
    const a2 = assistant(u2.info.id as MessageID)
    const changed = materialize([u1, a1, u2, a2])
    // 尾节点 assistant 无可设字段（parentID 已有语义、无后继），不在变更清单
    expect(changed.map((n) => n.info.id)).toStrictEqual(ids([u1, a1, u2]))
    expect(hasExplicitBranches([u1, a1, u2, a2])).toBe(true)
    expect(a1.info.selectedChildID).toBe(u2.info.id)
    expect(u2.info.selectedChildID).toBe(a2.info.id)
  })

  test("already materialized session is a no-op", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    setChild(u1, a1)
    expect(materialize([u1, a1])).toStrictEqual([])
  })

  test("empty history is a no-op", () => {
    expect(materialize([])).toStrictEqual([])
  })
})

describe("session.message-tree.appendBranch", () => {
  test("hangs the new chain under the parent and repoints the selection", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const nodes = materialize([u1, a1])
    const u2 = treeUser(u1.info.id as MessageID)
    const branch = [u2]
    const result = appendBranch(nodes, u1.info.id as MessageID, branch)
    // 父节点改选新分支 + 新链携带指针
    expect(result.changed.map((n) => n.info.id)).toStrictEqual(ids([u1, u2]))
    expect(u1.info.selectedChildID).toBe(u2.info.id)
    expect(result.newRootID).toBeUndefined()
    // 可见路径切到新分支，旧回答保留在树里（全量集合 = 原有 + 新分支）
    expect(visiblePath([...nodes, u2]).map((n) => n.info.id)).toStrictEqual(ids([u1, u2]))
  })

  test("multi-message chain is wired internally", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const nodes = materialize([u1, a1])
    const u2 = user()
    const a2 = assistant(u2.info.id as MessageID)
    const result = appendBranch(nodes, u1.info.id as MessageID, [u2, a2])
    expect(u2.info.parentID).toBe(u1.info.id)
    expect(u2.info.selectedChildID).toBe(a2.info.id)
    expect(a2.info.selectedChildID).toBeUndefined()
    expect(a2.info.parentID).toBe(u2.info.id)
    expect(result.changed.map((n) => n.info.id)).toStrictEqual(ids([u1, u2, a2]))
  })

  test("re-rooting returns the new root for the session-level pointer", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const nodes = materialize([u1, a1])
    const u1b = user()
    const result = appendBranch(nodes, undefined, [u1b])
    expect(result.newRootID).toBe(u1b.info.id)
    expect(u1b.info.parentID).toBeUndefined()
    // 时序探测拿错根（u1 更老）——重根会话必须传会话级指针
    expect(visiblePath([...nodes, u1b], u1b.info.id as MessageID).map((n) => n.info.id)).toStrictEqual(
      ids([u1b]),
    )
  })

  test("missing parent throws instead of silently skipping", () => {
    const u1 = user()
    const nodes = materialize([u1])
    const u2 = treeUser("msg_missing" as unknown as MessageID)
    expect(() => appendBranch(nodes, "msg_missing" as unknown as MessageID, [u2])).toThrow(
      /parent message .* not found/,
    )
  })
})

describe("session.message-tree.selectVersion", () => {
  test("switches the parent pointer back to the old branch", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const a2 = assistant(u1.info.id as MessageID)
    const nodes = [u1, a1, a2]
    setChild(u1, a2)
    const result = selectVersion(nodes, a1.info.id as MessageID)
    expect(result.changed.map((n) => n.info.id)).toStrictEqual(ids([u1]))
    expect(u1.info.selectedChildID).toBe(a1.info.id)
    expect(visiblePath(nodes).map((n) => n.info.id)).toStrictEqual(ids([u1, a1]))
  })

  test("target whose parent is off the visible path is rejected", () => {
    // a1 下有 u2 / u2b 两个后续，选中 u2b；a2 挂在被弃的 u2 下——它的父节点
    // u2 不在可见路径上，切换没有可见效果，拒绝
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u2 = treeUser(a1.info.id as MessageID)
    const a2 = assistant(u2.info.id as MessageID)
    const u2b = treeUser(a1.info.id as MessageID)
    const nodes = [u1, a1, u2, a2, u2b]
    setChild(u1, a1)
    setChild(a1, u2b)
    expect(selectVersion(nodes, a2.info.id as MessageID).changed).toStrictEqual([])
  })

  test("root version switch returns the new root for the session pointer", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u1b = user()
    const nodes = [u1, a1, u1b]
    setChild(u1, a1)
    const result = selectVersion(nodes, u1b.info.id as MessageID)
    expect(result.changed).toStrictEqual([])
    expect(result.newRootID).toBe(u1b.info.id)
    expect(visiblePath(nodes, u1b.info.id as MessageID).map((n) => n.info.id)).toStrictEqual(ids([u1b]))
  })

  test("branchless history rejects switching (nothing to switch between)", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    expect(selectVersion([u1, a1], a1.info.id as MessageID).changed).toStrictEqual([])
  })
})
