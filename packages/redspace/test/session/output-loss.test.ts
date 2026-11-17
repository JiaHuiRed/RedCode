import { expect, test } from "bun:test"
import { OutputLoss } from "@/session/output-loss"

const eligible = { finish: "stop", parts: [] }

// 261106 Red 真实样本（ses_ffe5e512394f9ffeJW6seduTjEh4zv，opencode-go/glm-5.3-flash）：
// 正文以冒号结尾、finish=stop、零工具 part，usage 却报 429 个 output token。
test("detects a turn that ends on an action announcement with no tool call", () => {
  const loss = OutputLoss.detect({ ...eligible, outputTokens: 429, text: "这次真的动手，先把上两轮说好的修补落到 prompt.ts：" })
  expect(loss).toBeDefined()
  expect(loss!.missingTokens).toBeGreaterThan(300)
})

test("half-width colon and trailing whitespace count as the same shape", () => {
  expect(OutputLoss.detect({ ...eligible, outputTokens: 100, text: "Now apply the patch:  " })).toBeDefined()
})

// 空正文不归这里管：循环已有的 reasoningOnly / producedNothing 会用各自的提示兜底，
// 这里再判会抢走它们、而且没有「预告」可引用。
test("empty or whitespace-only bodies are left to the existing empty-turn handling", () => {
  expect(OutputLoss.detect({ ...eligible, outputTokens: 882, text: "" })).toBeUndefined()
  expect(OutputLoss.detect({ ...eligible, outputTokens: 882, text: "   " })).toBeUndefined()
})

// token 差额不是判据：正常长回答/短回答的 usage 普遍比可见文本大几百 token，
// 按差额判定会在历史会话里命中数百条误报（step-3.7-flash / step-5-preview 实测）。
test("complete answers do not trigger regardless of usage inflation", () => {
  expect(OutputLoss.detect({ ...eligible, outputTokens: 4344, text: "哥哥，代码我摸完了，下面是查证结果。" })).toBeUndefined()
  expect(OutputLoss.detect({ ...eligible, outputTokens: 20, text: "好的，已经完成。" })).toBeUndefined()
  expect(OutputLoss.detect({ ...eligible, outputTokens: 853, text: "测".repeat(2501) })).toBeUndefined()
})

test("only stop without any tool part enters the heuristic", () => {
  const input = { ...eligible, outputTokens: 100, text: "Now apply the patch:" }
  expect(OutputLoss.detect(input)).toBeDefined()
  expect(OutputLoss.detect({ ...input, finish: "length" })).toBeUndefined()
  expect(OutputLoss.detect({ ...input, finish: "unknown" })).toBeUndefined()
  const providerTool = { type: "tool", metadata: { providerExecuted: true } }
  expect(OutputLoss.detect({ ...input, parts: [providerTool] })).toBeUndefined()
})

test("a legitimate colon ending is still ambiguous and the notice does not claim token loss", () => {
  expect(OutputLoss.detect({ ...eligible, outputTokens: 100, text: "https:" })).toBeDefined()
  const withTokens = OutputLoss.notice()
  expect(withTokens).not.toContain("415")
  expect(withTokens).toContain("可能是正常结束")
  expect(Buffer.byteLength(withTokens, "utf8")).toBeLessThan(1024)
  expect(Buffer.byteLength(OutputLoss.notice(), "utf8")).toBeLessThan(1024)
})
