type Part = { type: string; metadata?: { [key: string]: unknown } }

// A parent steering receipt remains visible history, but does not start a turn.
// Do not exclude all synthetic messages: compaction and task results use them too.
export function isTaskSteerRecord(parts: readonly Part[] | undefined) {
  return parts?.some((part) => part.type === "text" && part.metadata?.task_steer_record !== undefined) ?? false
}

export function isUserTurn<T extends { role: string }>(
  message: T,
  parts: readonly Part[] | undefined,
): message is T & { role: "user" } {
  // SSE publishes message metadata before its parts. Wait for the parts rather
  // than briefly treating an unclassified receipt as a new user turn.
  return message.role === "user" && parts !== undefined && !isTaskSteerRecord(parts)
}
