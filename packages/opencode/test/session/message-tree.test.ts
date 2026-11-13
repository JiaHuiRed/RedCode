import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
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

  test("leafID walks backward via parentID and reverses into the path", () => {
    // u1 → a1 → u2 → a2（选中链）+ u2b 弃用支线；数组序是创建序
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u2 = treeUser(a1.info.id as MessageID)
    const a2 = assistant(u2.info.id as MessageID)
    const u2b = treeUser(a1.info.id as MessageID)
    const a2b = assistant(u2b.info.id as MessageID)
    const nodes = [u1, a1, u2, a2, u2b, a2b]
    setChild(u1, a1)
    setChild(a1, u2)
    setChild(u2, a2)
    // 弃用支线内部指针原样保留（demo 的「恢复该版本已选后续」语义）
    setChild(u2b, a2b)
    // 叶指针指向选中链的尾 → 反向走链 = [u1, a1, u2, a2]；时序探测会拿错
    expect(visiblePath(nodes, { leafID: a2.info.id as MessageID }).map((n) => n.info.id)).toStrictEqual(
      ids([u1, a1, u2, a2]),
    )
    // 指向弃用支线叶 → 该支线即当时可见路径
    expect(visiblePath(nodes, { leafID: a2b.info.id as MessageID }).map((n) => n.info.id)).toStrictEqual(
      ids([u1, a1, u2b, a2b]),
    )
  })

  test("leafID takes precedence over forward root detection", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const nodes = [u1, a1]
    setChild(u1, a1)
    // 无 parentID 的 root：反向走链在 root 停止
    expect(visiblePath(nodes, { leafID: a1.info.id as MessageID }).map((n) => n.info.id)).toStrictEqual(
      ids([u1, a1]),
    )
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
    expect(visiblePath([...nodes, u1b], { rootID: u1b.info.id as MessageID }).map((n) => n.info.id)).toStrictEqual(
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
    expect(visiblePath(nodes, { rootID: u1b.info.id as MessageID }).map((n) => n.info.id)).toStrictEqual(ids([u1b]))
  })

  test("branchless history rejects switching (nothing to switch between)", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    expect(selectVersion([u1, a1], a1.info.id as MessageID).changed).toStrictEqual([])
  })
})


// 261114 Red 链式过滤（filterCompactedOrdered 的 chain 走）纯函数用例：走链与
// 压缩边界/DCP 覆盖段共享一趟扫描的语义在此钉死。DB 级组合由 prompt 套件回归。
describe("session.message-tree.chainWalk", () => {
  const withParts = (node: Node, parts: MessageV2.Part[] = []): MessageV2.WithParts => ({
    info: node.info,
    parts,
  })
  const textPart = (text: string): MessageV2.Part => ({ type: "text", text }) as MessageV2.Part
  const compactionPart = (tailStartID?: string): MessageV2.Part =>
    ({
      type: "compaction",
      auto: true,
      ...(tailStartID ? { tail_start_id: tailStartID } : {}),
    }) as MessageV2.Part

  test("linear materialized chain walks to the identical set (equivalence)", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u2 = user()
    const a2 = assistant(u2.info.id as MessageID)
    materialize([u1, a1, u2, a2])
    // newest-first 流（stream() 的产出序）
    const newestFirst = [a2, u2, a1, u1].map((n) => withParts(n, [textPart("x")]))
    const chain: MessageV2.ChainWalk = { wanted: a2.info.id as MessageID }
    const result = MessageV2.filterCompactedOrdered(newestFirst, chain)
    expect(result.map((m) => m.info.id)).toStrictEqual(ids([u1, a1, u2, a2]))
    expect(chain.wanted).toBeUndefined()
  })

  test("abandoned branch members are excluded from the chain", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const a2 = assistant(u1.info.id as MessageID)
    const u2b = treeUser(a1.info.id as MessageID)
    const a2b = assistant(u2b.info.id as MessageID)
    setChild(u1, a1)
    setChild(a1, u2b)
    // 流含全部存储行（弃用的 a2 也在），走链按 wanted 只收选中分支
    const newestFirst = [a2, a2b, u2b, a1, u1].map((n) => withParts(n, [textPart("x")]))
    const chain: MessageV2.ChainWalk = { wanted: a2b.info.id as MessageID }
    const result = MessageV2.filterCompactedOrdered(newestFirst, chain)
    expect(result.map((m) => m.info.id)).toStrictEqual(ids([u1, a1, u2b, a2b]))
  })

  test("compaction boundary with tail_start_id keeps the retained tail and stops the walk", () => {
    // 时序 u1,a1,u2,a2,c1(边界,tail_start=u2),s1(summary),u3,a3 —— 同
    // messages-pagination 的 retains-original-tail fixture 布局；物化补全指针
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u2 = user()
    const a2 = assistant(u2.info.id as MessageID)
    const c1 = user()
    const s1 = assistant(c1.info.id as MessageID, { summary: true, finish: "stop" } as Partial<MessageV2.Info>)
    const u3 = user()
    const a3 = assistant(u3.info.id as MessageID)
    materialize([u1, a1, u2, a2, c1, s1, u3, a3])
    const newestFirst = [a3, u3, s1, c1, a2, u2, a1, u1].map((n) => withParts(n, [textPart("x")]))
    // 边界部件挂在 c1 上；s1 是完整摘要 → completed.add(c1) → c1 命中边界 → retain=u2
    const withCompaction = newestFirst.map((m) =>
      m.info.id === c1.info.id ? withParts(c1, [compactionPart(u2.info.id)]) : m,
    )
    const chain: MessageV2.ChainWalk = { wanted: a3.info.id as MessageID }
    const result = MessageV2.filterCompactedOrdered(withCompaction, chain)
    // 与无 chain 版本同布局：[c1, s1, u2, a2, u3, a3]（边界重排 + 保留 tail）
    expect(result.map((m) => m.info.id)).toStrictEqual(ids([c1, s1, u2, a2, u3, a3]))
  })

  test("stall fires when the chain cannot reach the root", () => {
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u2 = treeUser(a1.info.id as MessageID)
    // u2 的父指针指向缺失消息（写入方漏接线的形态）
    ;(u2.info as { parentID?: MessageID }).parentID = "msg_missing" as unknown as MessageID
    setChild(u1, u2)
    const stream = [u2, u1].map((n) => withParts(n, [textPart("x")]))
    const stalls: string[] = []
    const chain: MessageV2.ChainWalk = {
      wanted: u2.info.id as MessageID,
      onStall: (wanted) => stalls.push(wanted),
    }
    const result = MessageV2.filterCompactedOrdered(stream, chain)
    // 链只收成员：u1 在断点之下，不进输出；stall 带断点 id 响一声
    expect(result.map((m) => m.info.id)).toStrictEqual(ids([u2]))
    expect(stalls).toStrictEqual(["msg_missing"])
  })

  test("detour crosses a DCP-covered span and resumes at the anchor", () => {
    // u1,a1,u2,a2；块覆盖 [a1..u2]，anchor=a1（范围最旧、流过滤器豁免）
    const u1 = user()
    const a1 = assistant(u1.info.id as MessageID)
    const u2 = treeUser(a1.info.id as MessageID)
    const a2 = assistant(u2.info.id as MessageID)
    // native 流形态：covered 非 anchor（u2）已被下推过滤，不在流里
    const stream = [a2, a1, u1].map((n) => withParts(n, [textPart("x")]))
    const chain: MessageV2.ChainWalk = {
      wanted: a2.info.id as MessageID,
      skip: (id) => (id === u2.info.id ? (a1.info.id as MessageID) : id),
    }
    const result = MessageV2.filterCompactedOrdered(stream, chain)
    // a2 → (parent u2 被覆盖 → 改道 anchor a1) → a1 → u1；输出为时序（reverse 后）
    expect(result.map((m) => m.info.id)).toStrictEqual(ids([u1, a1, a2]))
    expect(chain.wanted).toBeUndefined()
  })
})
