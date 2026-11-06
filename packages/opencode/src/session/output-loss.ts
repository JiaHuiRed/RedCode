// 261106 Red 上游丢 tool call 的可见性兜底。
// 实测 opencode-go/glm-5.3-flash 连续多轮：模型在思考里明确「立即执行」，正文以「：」结尾，
// 然后 finish=stop、零工具 part——但 usage 的 output tokens 比可见正文多出 320~880。
// 差额正是被上游吞掉的 tool call 参数（body 与 tool_calls 都没到达客户端）。
//
// 判据**只认「正文以动作预告（冒号）结尾」这一形态**，不拿 token 差额当门槛：
// 实测 step-3.7-flash / step-5-preview 的 usage 普遍比可见文本大几百到上千 token（正常
// 回答也如此，历史库里按差额判定会命中数百条误报）。冒号收尾 + 零工具才是「话说一半」的
// 可靠信号。missingTokens 仍作为日志证据返回，用来说明上游丢了多少输出。
//
// 是否续跑、是否落告警由 prompt 循环决定：
//   - 先续跑一次（限 1 次），让模型用原生通道重发；
//   - 仍丢就落可见说明，不再让会话无声停下。
// 决策与误报面证据见 docs/notes/implemented/bug-fix/2026-11-06-upstream-dropped-tool-call.md。
import { Token } from "@/util/token"

const ANNOUNCEMENT_TAIL = /[:：]\s*$/

export type OutputLoss = {
  readonly missingTokens: number
}

export function detect(input: { outputTokens: number; text: string }): OutputLoss | undefined {
  const trimmed = input.text.trimEnd()
  // 空正文不在这里处理：那种形态交给循环已有的 reasoningOnly / producedNothing 兜底，
  // 否则「只思考不回答」会被这里抢走，续跑提示也对不上（没有预告可引用）。
  if (!trimmed || !ANNOUNCEMENT_TAIL.test(trimmed)) return undefined
  const visibleTokens = Token.estimateReporting(input.text)
  return { missingTokens: Math.max(0, input.outputTokens - visibleTokens) }
}

export const RECOVERY_PROMPT = [
  "[System notice] Your previous turn announced an action (it ended with a colon) but produced no tool call.",
  "Call the tool you intended to call now, using the native tool channel. Do not repeat the plan or the explanation.",
].join("\n")

export function notice(missingTokens: number) {
  const suffix = missingTokens > 0 ? `；另有约 ${missingTokens} 个输出 token 没有落到正文里` : ""
  return `[RedCode] 本轮以动作预告结尾（“…：”）但没有发出任何工具调用就结束了${suffix}。通常是上游把 tool call 丢掉了——可以直接重发，或换个模型/供应商。`
}

export * as OutputLoss from "./output-loss"
