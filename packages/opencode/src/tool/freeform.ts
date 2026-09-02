/**
 * Freeform（文法约束）工具形态。
 *
 * 260902 cc GPT-5 系在 Responses API 上有 custom tool：工具调用不走 JSON，模型直接吐一段
 * 受 Lark 文法约束的裸文本（`custom_tool_call`，input 是字符串而不是对象）。codex 唯一这么
 * 发的工具就是 apply_patch —— 见 codex-rs/core/src/tools/handlers/apply_patch_spec.rs 和
 * core/assets/tools/apply_patch.lark。
 *
 * 为什么值得单独做一份形态：补丁正文本来就是纯文本，包进 JSON 字符串等于给每个换行和引号
 * 加一层转义。两处代价——① token 明显变多；② 离模型训练时的输出分布更远，转义错一个字符
 * 整条工具调用就废了（JSON 解析失败 → repairToolCall → 一轮白跑）。文法约束这条路上，
 * 解码器在采样阶段就被 Lark 挡住，语法上不可能吐出不合法的补丁。
 *
 * 适用面刻意收窄：只有 `sdk.responses()` 那条路（provider.ts 里 openai 走的就是它）才有
 * custom tool，chat completions 没有这个概念。所以判据 = 官方 openai provider + gpt-5 家族。
 */

/** codex core/assets/tools/apply_patch.lark 原样搬运（不含 environment_id 那个可选扩展）。 */
const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

export interface Spec {
  /** Lark 文法，作为 custom tool 的 format.definition 直接下发。 */
  readonly grammar: string
  /** 追加到工具原描述后面的一句话，告诉模型这次不要包 JSON。 */
  readonly note: string
  /** 把裸字符串还原成本仓工具执行器认识的对象入参。 */
  readonly toArgs: (input: string) => Record<string, unknown>
}

/** 有 freeform 形态的工具。键是 ToolRegistry 里的工具 id。 */
export const SPECS: Record<string, Spec> = {
  apply_patch: {
    grammar: APPLY_PATCH_GRAMMAR,
    note: "This is a FREEFORM tool: emit the patch text directly, do not wrap it in JSON.",
    toArgs: (input) => ({ patchText: input }),
  },
}

/** 与 transform.ts 的 GPT5_FAMILY_RE 同源：锚在串首或 "/" 上，避免误伤 gpt-50 / gpt-5o。 */
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/

type ModelLike = {
  readonly providerID: string
  readonly api: { readonly id: string; readonly npm?: string }
}

/** 逃生口：形态出问题时不用降级整个 provider，置 1 即回到 JSON 函数工具。 */
const disabled = () => process.env["REDCODE_DISABLE_FREEFORM_TOOLS"] === "1"

export function supported(model: ModelLike): boolean {
  if (disabled()) return false
  // custom tool 只存在于 Responses API。provider.ts 里 openai 的 getModel 固定走 sdk.responses()，
  // 别的 provider（含 azure / copilot / 各家中转）没验过，不放进来。
  if (model.providerID !== "openai" || model.api.npm !== "@ai-sdk/openai") return false
  const id = model.api.id
  // gpt-5-chat 不是 reasoning 模型、也不吃 custom tool，排除。
  return GPT5_FAMILY_RE.test(id) && !id.includes("-chat")
}

/** 该模型该工具是否走 freeform；不走则返回 undefined。 */
export function spec(model: ModelLike, toolID: string): Spec | undefined {
  if (!supported(model)) return undefined
  return SPECS[toolID]
}

/**
 * 工具调用入参归一。
 *
 * freeform 工具回来的 input 是裸字符串（AI SDK 用 tool 的 inputSchema `{type:"string"}` 解出来的），
 * 而本仓执行器、落库的 part.state.input、以及 TUI/GUI 的渲染器全按对象形状写的。所以在
 * 「进执行器」和「进消息存储」两个边界上都要过这一道，两边形状才一致。
 * 非 freeform 工具或非字符串入参返回 undefined，由调用方走原路径。
 */
export function normalizeInput(toolID: string, input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "string") return undefined
  return SPECS[toolID]?.toArgs(input)
}

export * as Freeform from "./freeform"
