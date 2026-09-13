// 260913 Red 用户正在阅读旧历史时放宽每会话消息上限。
//
// 立即裁剪（event-reducer 的 MAX_MESSAGES_PER_SESSION）会在用户往回翻的时候把正在看的
// 那些行从脚下抽走：新消息流式到达 → shift 掉最旧一条 → 视口内容整体上移。
//
// 与参考实现不同，这里**不**取消上限，只是把上限放大到 HELD_MESSAGES_PER_SESSION：
// 长时间无人值守的流式会话仍然有界，不会把内存撑爆。
export const HELD_MESSAGES_PER_SESSION = 400

const readers = new Map<string, number>()

const keyOf = (directory: string, sessionID: string) => `${directory}\u0000${sessionID}`

// 引用计数：同一会话可能有多个持有方（滚动效果重建、嵌套组件），最后一个释放才算解除。
export function holdMessageWindow(directory: string, sessionID: string) {
  const key = keyOf(directory, sessionID)
  readers.set(key, (readers.get(key) ?? 0) + 1)
  return () => {
    const next = (readers.get(key) ?? 1) - 1
    if (next > 0) {
      readers.set(key, next)
      return
    }
    readers.delete(key)
  }
}

export function messageWindowLimit(directory: string, sessionID: string, fallback: number) {
  if (!readers.has(keyOf(directory, sessionID))) return fallback
  return Math.max(fallback, HELD_MESSAGES_PER_SESSION)
}
