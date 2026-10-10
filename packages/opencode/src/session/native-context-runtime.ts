import { createHash } from "node:crypto"
import { NativeCompaction } from "@/config/native-compaction"
import { MessageV2 } from "./message-v2"
import * as ContextCompaction from "./context-compaction"
import * as NativeContext from "./native-context"
import { settlePromptCaches } from "./prompt-caches"
import type { SessionID } from "./schema"

// 261010 Red 压缩版本由持久化活跃块决定；恢复/重启不依赖插件旁路状态。
export function revision(sessionID: SessionID) {
  return createHash("sha256").update(JSON.stringify(ContextCompaction.list(sessionID)
    .map((block) => block.id))).digest("hex")
}

export function settle(sessionID: SessionID, previous: string, next: string) {
  if (previous !== next) settlePromptCaches(sessionID, "native-compaction")
}

export function history(sessionID: SessionID, spec: NativeCompaction.Spec) {
  const blocks = ContextCompaction.list(sessionID)
  const anchors = new Set(blocks.map((block) => block.anchorID))
  const covered = new Set(blocks.flatMap((block) => block.sourceMessageIDs))
  function* visible() {
    let count = 0
    for (const message of MessageV2.stream(sessionID)) {
      if (covered.has(message.info.id) && !anchors.has(message.info.id)) continue
      if (++count > spec.maxMessages) throw new Error("Native history exceeds the configured message budget")
      yield message
    }
  }
  return MessageV2.filterCompactedOrdered(visible())
}

export function project(sessionID: SessionID, messages: MessageV2.WithParts[], spec: NativeCompaction.Spec) {
  return NativeContext.annotate(
    ContextCompaction.project(NativeContext.removeArtifacts(messages), ContextCompaction.list(sessionID)),
    spec.maxMessages,
  )
}
