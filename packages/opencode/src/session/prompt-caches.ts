import type { ModelMessage } from "ai"
import * as Log from "@redcode-ai/core/util/log"

const log = Log.create({ service: "prompt-caches" })

// 260617 Red session-level caches: snapshot once per session to stabilize system prompt for prefix caching.
// Without caching, instruction.system() re-reads disk every turn — any file change (MEMORY.md, AGENTS.md,
// skill files) mutates the system prompt and invalidates DeepSeek prefix cache mid-session.
// 260620 Red use globalThis for cache storage — bun compile may instantiate module multiple times,
// causing module-level `let` to be duplicated across instances. globalThis ensures single shared cache.
// 260811 cc audit R4: 从 prompt.ts 抽出为独立模块，让 compact 边界的"分代结算"可以被
// 会话循环调用而不制造循环依赖。
export const PromptCaches = ((globalThis as any).__rc_prompt_caches ??= {
  system: undefined as
    | { sessionID: string; modelKey: string; skills: string | undefined; env: string[]; instructions: string[] }
    | undefined,
  msgPin: undefined as { sessionID: string; messages: Map<string, unknown[]> } | undefined,
  modelMsgs: undefined as { sessionID: string; modelKey: string; messages: ModelMessage[] } | undefined,
  // 260706 Red cache tool definitions (description+inputSchema) for prefix stability.
  // describeSkill()/describeTask() rebuild tool descriptions from disk every step via Glob.scan;
  // if skill/agent lists change mid-session the tool schema JSON mutates → prefix cache breaks.
  // 260804 Red tools cache is model-agnostic (descriptions come from disk, not model) — no modelKey.
  tools: undefined as { sessionID: string; defs: Map<string, { description: string; inputSchema: unknown }> } | undefined,
})

// 260811 cc audit R4 分代结算（哥哥拍板：缓存优先）：
// msgPin/modelMsgs 把已发送的消息钉死在首次快照上——这是前缀缓存的命根子，但也意味着
// 一切对旧消息的改写（compaction prune 打的 compacted 标记、DCP 的压缩改写）在平时
// 全部被钉回去、不生效。这不是 bug 而是取舍：改写必然从改写点起炸掉前缀缓存。
// 结算点选在 compact 边界——摘要重写反正要重建缓存，累积改写搭同一班车等于免费：
//   soft(0.6)  提醒，不动前缀
//   prune(0.8) 只记账（标记入库，prompt 仍走钉死快照）
//   compact    结算：丢弃 msgPin/modelMsgs → 下一轮从库里重新钉（prune 标记、DCP 改写
//              一并生效），内存里的整套快照双份同时释放
// system/tools 两个缓存与消息历史无关，不参与结算。
export function settlePromptCaches(sessionID: string, reason: string) {
  let dropped = 0
  if (PromptCaches.msgPin?.sessionID === sessionID) {
    dropped += PromptCaches.msgPin.messages.size
    PromptCaches.msgPin = undefined
  }
  if (PromptCaches.modelMsgs?.sessionID === sessionID) {
    dropped += PromptCaches.modelMsgs.messages.length
    PromptCaches.modelMsgs = undefined
  }
  if (dropped > 0) log.info("settled", { sessionID, reason, droppedEntries: dropped })
  return dropped
}
