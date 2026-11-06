// 261106 Red 上游丢 tool call 的可见性兜底。
// 实测 opencode-go/glm-5.3-flash 连续多轮：模型在思考里明确「立即执行」，正文以「：」结尾，
// 然后 finish=stop、零工具 part——但 usage 的 output tokens 比可见正文多出 320~880。
// 但差额也可能包含正常的隐藏推理，不能证明丢失了多少输出或确定丢包原因。
//
// 判据**只认「正文以动作预告（冒号）结尾」这一形态**，不拿 token 差额当门槛：
// 实测 step-3.7-flash / step-5-preview 的 usage 普遍比可见文本大几百到上千 token（正常
// 回答也如此，历史库里按差额判定会命中数百条误报）。冒号收尾 + 零工具仅是启发式，
// 正常回答也可能命中；missingTokens 只是未落正文的估算差额，并非丢失量。
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

export function detect(input: {
  outputTokens: number
  text: string
  finish: string | undefined
  parts: readonly { type: string }[]
}): OutputLoss | undefined {
  if (input.finish !== "stop" || input.parts.some((part) => part.type === "tool")) return undefined
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

export function notice() {
  return `[RedCode] 本轮以冒号结尾且没有工具调用，自动续跑一次后仍出现相同情况。可能是回复未完成，也可能是正常结束；如需继续，可以重发或换个模型/供应商。`
}

export * as OutputLoss from "./output-loss"
