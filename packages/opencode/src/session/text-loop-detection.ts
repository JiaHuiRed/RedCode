// 260710 Red 文本重复检测：防模型跑飞（灵感来自 MiMo-Code）
// 双层检测：
//   1. N-gram：单次输出内滑动窗口检测重复模式 → 触发中断
//   2. Loop Recovery：跨 step 检测连续相似文本 → 渐进干预

// ─── N-gram 检测（流式 delta 累积） ─────────────────────────────

const NGRAM_WINDOW = 80 // 每个 gram 的字符长度
const NGRAM_REPEAT_THRESHOLD = 3 // 同一 gram 出现 N 次判定重复
const NGRAM_CHECK_INTERVAL = 200 // 每累积 N 字符检测一次（降低开销）

export class NgramDetector {
  private buffer = ""
  private sinceLastCheck = 0

  reset() {
    this.buffer = ""
    this.sinceLastCheck = 0
  }

  /** 喂入 delta 文本，返回 true 表示检测到重复 */
  feed(delta: string): boolean {
    this.buffer += delta
    this.sinceLastCheck += delta.length
    if (this.sinceLastCheck < NGRAM_CHECK_INTERVAL) return false
    this.sinceLastCheck = 0
    return this.check()
  }

  private check(): boolean {
    if (this.buffer.length < NGRAM_WINDOW * NGRAM_REPEAT_THRESHOLD) return false
    // 从尾部取最近的文本做检测，避免扫全文
    const tail = this.buffer.slice(-(NGRAM_WINDOW * NGRAM_REPEAT_THRESHOLD * 3))
    const counts = new Map<string, number>()
    // 步长 = 半窗口，平衡精度与性能
    const step = Math.max(1, Math.floor(NGRAM_WINDOW / 2))
    for (let i = 0; i <= tail.length - NGRAM_WINDOW; i += step) {
      const gram = tail.slice(i, i + NGRAM_WINDOW)
      const count = (counts.get(gram) || 0) + 1
      if (count >= NGRAM_REPEAT_THRESHOLD) return true
      counts.set(gram, count)
    }
    return false
  }
}

// ─── Loop Recovery（跨 step 文本相似度检测） ────────────────────

const SIMILARITY_THRESHOLD = 0.85 // 文本相似度阈值
const TAIL_CHARS = 500 // 取尾部 N 字符做比较（足够代表性且快）

export type RecoveryLevel = "nudge" | "replan" | "stop"

export class LoopRecoveryTracker {
  private history: string[] = []
  private consecutiveHits = 0

  reset() {
    this.history = []
    this.consecutiveHits = 0
  }

  /**
   * 记录一次完整文本输出，返回干预级别（null = 无需干预）
   * 渐进式：第1次 nudge（温和提示）→ 第2次 replan（强制重新规划）→ 第3次 stop（终止）
   */
  record(text: string): RecoveryLevel | null {
    const tail = text.slice(-TAIL_CHARS)
    if (tail.length < 20) {
      // 太短的输出不参与检测
      this.history.push(tail)
      return null
    }

    const isSimilar = this.history.length > 0 && similarity(tail, this.history[this.history.length - 1]) >= SIMILARITY_THRESHOLD

    this.history.push(tail)
    // 只保留最近 5 条
    if (this.history.length > 5) this.history.shift()

    if (!isSimilar) {
      this.consecutiveHits = 0
      return null
    }

    this.consecutiveHits++
    if (this.consecutiveHits >= 3) return "stop"
    if (this.consecutiveHits >= 2) return "replan"
    return "nudge"
  }
}

/** 简易 bigram 相似度（Dice coefficient），O(n) 快速比较 */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0

  const bigrams = (s: string) => {
    const set = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.slice(i, i + 2)
      set.set(bi, (set.get(bi) || 0) + 1)
    }
    return set
  }

  const aGrams = bigrams(a)
  const bGrams = bigrams(b)
  let intersection = 0
  for (const [bi, count] of aGrams) {
    intersection += Math.min(count, bGrams.get(bi) || 0)
  }
  return (2 * intersection) / (a.length - 1 + b.length - 1)
}

// ─── 恢复提示模板 ────────────────────────────────────────────

export const RECOVERY_PROMPTS: Record<RecoveryLevel, string> = {
  nudge:
    "[System notice] Your recent outputs appear very similar to previous ones. Please re-read the user's request carefully and provide a different, substantive response. Avoid repeating the same content.",
  replan:
    "[System notice] You are stuck in a repetition loop. STOP what you are doing. Re-examine the original task from scratch, consider a completely different approach, and respond with a new plan of action.",
  stop:
    "[System notice] Repetition loop detected after multiple recovery attempts. Halting to prevent further wasted tokens. Please try a different prompt or approach.",
}
