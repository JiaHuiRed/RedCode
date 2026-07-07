import { normalizePromptHistoryEntry, type PromptHistoryStoredEntry } from "./history"

// 260707 Red 历史前缀匹配的 ghost 补全（fish/zsh-autosuggestions 风格）：
// 从最近历史里找第一条「纯文本、以当前输入为前缀、且更长」的条目，返回其超出当前输入的后缀。
// entries[0] 为最近一条，从新到旧遍历，命中即返回。
export function findHistorySuggestion(entries: PromptHistoryStoredEntry[], current: string): string {
  if (!current) return ""
  for (const raw of entries) {
    const entry = normalizePromptHistoryEntry(raw)
    if (entry.prompt.some((part) => part.type !== "text")) continue
    const text = entry.prompt.map((part) => ("content" in part ? part.content : "")).join("")
    if (text.length > current.length && text.startsWith(current)) {
      return text.slice(current.length)
    }
  }
  return ""
}
