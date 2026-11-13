import { createHash } from "node:crypto"
import { NativeCompaction } from "@/config/native-compaction"
import { MessageV2 } from "./message-v2"
import * as ContextCompaction from "./context-compaction"
import * as NativeContext from "./native-context"
import { settlePromptCaches } from "./prompt-caches"
import type { MessageID, SessionID } from "./schema"

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
// 261114 Red chain（消息树走链）传入时：covered 段的成员在 stream 层就被跳过，
//   走链的 wanted 若落进覆盖段会永远等不到匹配——skip 改道表把覆盖段成员直接
//   指到该块的 anchor（范围最旧一条、被流过滤器豁免），走链越过整段折叠区后
//   在 anchor 恢复。anchorID = selected[0]（范围最旧，context-compaction commit）。
export function history(
  sessionID: SessionID,
  spec: NativeCompaction.Spec,
  blocks?: ContextCompaction.Block[],
  chain?: MessageV2.ChainWalk,
) {
  const active = blocks ?? ContextCompaction.list(sessionID)
  const anchors = new Set(active.map((block) => block.anchorID))
  const covered = new Set(active.flatMap((block) => block.sourceMessageIDs))
  if (chain && active.length > 0) {
    const detour = new Map<MessageID, MessageID>()
    for (const block of active) {
      for (const id of block.sourceMessageIDs) {
        if (id !== block.anchorID) detour.set(id, block.anchorID)
      }
    }
    chain.skip = (id) => detour.get(id) ?? id
  }
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
  return MessageV2.filterCompactedOrdered(visible(), chain)
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
