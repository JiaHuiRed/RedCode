// 261113 Red 压缩成功边界判定：finish 有值不代表摘要完整。
//   "unknown" 是无供应商回执的估算 step-finish（自动中止/流断），
//   "length"  是输出撞上长度上限被截断。
// 两者都可能只留下半份摘要；把它当成功边界，被压缩的原文就会从后续模型输入里消失。
// 压缩提交入口、历史投影与 TUI 翻页必须共用这一判据 —— 独立成模块是为了让 TUI
// 只为一个布尔判定去加载 message-v2 的模型/数据库依赖。
export function isCompleteSummary(info: { finish?: string; error?: unknown }): boolean {
  return !!info.finish && info.finish !== "unknown" && info.finish !== "length" && !info.error
}
