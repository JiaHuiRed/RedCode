import type { Message, Part } from "@redcode-ai/sdk/v2"

// 261027 Red 与 TUI 同口径：按本轮 assistant 消息统计，同一消息内的重复 callID 只算一次。
export function countTurnToolCalls(messages: readonly Message[], parts: Record<string, Part[]>, parentID: string, end: number) {
  return messages
    .filter((message) => message.role === "assistant" && message.parentID === parentID && message.time.created <= end)
    .reduce((count, message) => {
      const calls = new Set<string>()
      for (const part of parts[message.id] ?? []) {
        if (part.type === "tool") calls.add(part.callID)
      }
      return count + calls.size
    }, 0)
}
