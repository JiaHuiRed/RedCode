import { createHash } from "node:crypto"
import { NativeCompaction } from "@/config/native-compaction"
import { MessageV2 } from "./message-v2"
import * as ContextCompaction from "./context-compaction"
import * as NativeContext from "./native-context"
import { settlePromptCaches } from "./prompt-caches"
import type { SessionID } from "./schema"
import { visiblePath } from "./message-tree"

// 261010 Red 压缩版本由持久化活跃块决定；恢复/重启不依赖插件旁路状态。
// 261105 Red 只 hash 块 id（listIDs 不解析摘要），与 list().map(id) 结果一致。
export function revision(sessionID: SessionID) {
  return createHash("sha256").update(JSON.stringify(ContextCompaction.listIDs(sessionID))).digest("hex")
}

export function settle(sessionID: SessionID, previous: string, next: string) {
  if (previous !== next) settlePromptCaches(sessionID, "native-compaction")
}

// 261105 Red 可选传入同一 step 的活跃块快照：history 与 project 此前各读一次，
// 加上 revision 的 id 投影，同批块每步读库三遍。调用方不传时保持原行为。
// 261114 Red 树会话的可见路径过滤（正向 selectedChildID 链）只在无活跃块时做：
//   覆盖段被下推过滤后链在 anchor 处断头，跨段续走需要按块数据改道——那是
//   分支写入方（edit-resend）落地时的事，此刻不静默给出残缺路径。
export function history(sessionID: SessionID, spec: NativeCompaction.Spec, blocks?: ContextCompaction.Block[]) {
  const active = blocks ?? ContextCompaction.list(sessionID)
  const anchors = new Set(active.map((block) => block.anchorID))
  const covered = new Set(active.flatMap((block) => block.sourceMessageIDs))
  function* visible() {
    let count = 0
    // 261017 Red 过滤下推到分页层：被覆盖的消息连 part 都不再读（旧顺序是整页 hydrate
    // 完再 continue，长会话每轮都要把已折叠的正文从库里捞出来再扔掉）。
    const wanted = (info: MessageV2.Info) => !covered.has(info.id) || anchors.has(info.id)
    for (const message of MessageV2.stream(sessionID, wanted)) {
      if (++count > spec.maxMessages) throw new Error("Native history exceeds the configured message budget")
      yield message
    }
  }
  const ordered = MessageV2.filterCompactedOrdered(visible())
  return active.length === 0 ? visiblePath(ordered) : ordered
}

export function project(
  sessionID: SessionID,
  messages: MessageV2.WithParts[],
  spec: NativeCompaction.Spec,
  blocks?: ContextCompaction.Block[],
) {
  return NativeContext.annotate(
    ContextCompaction.project(
      NativeContext.cleanReferenceEchoes(NativeContext.removeArtifacts(messages)),
      blocks ?? ContextCompaction.list(sessionID),
    ),
    spec.maxMessages,
  )
}
