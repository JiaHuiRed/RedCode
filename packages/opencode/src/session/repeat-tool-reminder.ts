// 260814 Red 重复调用递进提醒（参考 DeepSeek Harness 的 repeat-tool-reminder 包）
// 决策与备选取舍见 docs/notes/implemented/feature/2026-08-14-repeat-tool-reminder-soft-layer.md
// 软层：同工具 + 同参连续调用达到阈值 → 把提醒贴在该次 tool output 尾部，纯建议不拦截。
// 与 processor 里的 doom-loop 硬层（要求报错或同输出、触发即弹权限）互补：
// 轮询类调用每次输出都在变，硬层永不触发，这里仍会数到 3 提醒模型别空转；
// 真空转则两层都在——软层先劝，硬层弹窗兜底。
//
// 注入通道选 tool output 尾部而非独立 user 消息——DCP user 角色注入的教训（260810
// 根治）：提醒语义上是「关于这次调用的系统注记」，贴 result 尾部不伪装角色，
// append-only 不破前缀缓存。
//
// 链口径：
// - 参数键与硬层 exactLoop 同口径（深层 key-sort），对象键重排不洗掉计数，数组顺序保留。
// - todowrite/todoread 对链透明——记账工具插在循环中间不该洗掉计数（grep→todowrite→grep
//   仍算连续两次 grep）。
// - pending/running 分片跳过不断链（并行同参调用会双计，保守略过）。
// - 调用方按 assistant.parentID 取当前用户轮次，用户新消息重置链。
// - 超过最高阈值后沉默（DSH 同款取舍）：持续轮询是合法行为，真空转有硬层弹窗。

import type { Part } from "./message-v2"

/** 递进阈值：3 轻提醒，5/8 详细版。升序，触发点为「含本次的总连续次数」恰等于阈值。 */
export const THRESHOLDS = [3, 5, 8] as const

/** 对链透明的记账工具：既不计数也不断链。 */
export const EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["todowrite", "todoread"])

/** 详细文案里参数预览的字符上限（头部截断，防 write/edit 大载荷灌进下一请求）。 */
const PREVIEW_CHARS = 500

/**
 * 数「本次之前」连续同 (tool, inputJSON) 的已完成调用次数。
 * @param parts 时间正序的最近 tool 分片，调用方已排除当前调用自身。
 */
export function chainLength(parts: readonly Part[], tool: string, inputJSON: string): number {
  let count = 0
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type !== "tool") continue
    if (EXCLUDED_TOOLS.has(part.tool)) continue
    if (part.state.status === "pending" || part.state.status === "running") continue
    if (part.tool !== tool) break
    if (inputKey(part.state.input) !== inputJSON) break
    count++
  }
  return count
}

// 260930 Red 软层、exactLoop、cycleLoop 共用参数键，避免只改一处造成判据漂移。
export function inputKey(input: unknown): string {
  return JSON.stringify(input, (_key: string, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
}

/**
 * 含本次共 count 次连续同参时的提醒文案；未命中阈值返回 null。
 * 文案体例对齐 text-loop-detection 的 RECOVERY_PROMPTS（[System notice] 前缀、英文）。
 */
export function reminderFor(tool: string, inputJSON: string, count: number): string | null {
  if (!(THRESHOLDS as readonly number[]).includes(count)) return null
  // 260930 Red 工具名也来自外部定义，和参数预览一起限长，整条注记保持在 4KiB 内。
  const toolPreview = tool.length > PREVIEW_CHARS ? `${tool.slice(0, PREVIEW_CHARS)}…` : tool
  if (count === THRESHOLDS[0]) {
    return (
      `[System notice] You have called "${toolPreview}" with identical arguments ${count} times in a row. ` +
      `Carefully analyze the previous result before calling again: if the task is not complete, ` +
      `try a different approach or different arguments instead of repeating the call.`
    )
  }
  const preview =
    inputJSON.length > PREVIEW_CHARS
      ? `${inputJSON.slice(0, PREVIEW_CHARS)}… (+${inputJSON.length - PREVIEW_CHARS} more chars)`
      : inputJSON
  return (
    `[System notice] Repeated tool call detected:\n` +
    `- tool: ${toolPreview}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${preview}\n` +
    `The repeated calls are not making progress. Do not call this tool with these exact arguments again. ` +
    `Inspect this result and choose a different action, different arguments, or finish the task if enough ` +
    `evidence has been gathered.`
  )
}
