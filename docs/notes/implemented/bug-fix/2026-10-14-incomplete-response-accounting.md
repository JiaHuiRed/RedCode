# 未完成响应的终态语义与实报用量保障

状态: implemented

## 问题

OpenAI Responses 的 `response.incomplete`（截断/过滤/中断）在两条 runtime 里都被当成成功完成：

- native 协议（`packages/llm/src/protocols/openai-responses.ts`）把它与 `response.completed` 同走 clean finish，`max_output_tokens` 映射为 `length` 后会话按成功收尾——截断被伪装成正常结束。
- AI SDK 路径（默认 runtime）里 provider 把 incomplete 统一成 finish chunk，会话层无从区分「真完成」与「被截断」。
- 对照官方 Codex：终态未完成返回带 reason 与 usage 的明确错误，`interrupted` 单独保留在可续接路径，`content_filter` 走硬错误。

另一处记账隐患：260803 的流断估算（`estimatedFinishEvents`）只判「有没有产出字节」，不判「当前 step 是否已有实报 finish」。若流在 `finish-step`（实报 usage 已落）之后才断，会再补一个幽灵 step 的估算输出——同一响应双重记账。

## 决策

终态未完成统一为「先记账、再报错」：

- **native**：`onResponseFinish` 在 `response.incomplete` 时照常发 `step-finish` + `finish`（实报 usage 只在此记账一次），随后追加 `provider-error`（有界 reason 文案）。`interrupted` 与已完成工具调用的轮次不追加，保持可续接。
- **AI SDK**：`finish-step` 记录 `rawFinishReason ∈ {max_output_tokens, content_filter}`（value-scoped），`finish` 事件（实报 usage）之后追加同样的 `provider-error`。分类与文案从 `@redcode-ai/llm/protocols/openai-responses` 子路径导出共用，两条 runtime 语义一致。
- **估算守卫**：adapter state 增加 `sawStepFinish`（start-step 清零、finish-step 置位），`estimatedFinishEvents` 见到即返回空——已有实报就不再估算。
- 会话层 `provider-error` 沿既有路径抛错收尾（`processor.ts` case `provider-error`），usage 已由 step-finish 落账；不加自动重试，不改 DeepSeek 长度续写，不动其他 provider。

## 备选与否决理由

- **把 finish reason 改成 `error` 表达未完成**：否决——usage/遥测保留 provider 真实停止原因（length/content-filter），终态信号由 provider-error 携带，职责分离。
- **AI SDK 侧按「未知 raw reason」判定终态**：否决——接缝处拿不到「这是 Responses API」的标记，未知字符串可能来自任何 provider 的 raw reason（Anthropic `pause_turn` 等），会误伤；已知两个字面量只有 Responses 会发。
- **`interrupted` 也报错**：否决——官方语义 end_turn=false、期望客户端续跑；报错会打断合法的续接轮。
- **在 processor 层识别 incomplete**：否决——两条 runtime 的事件已在适配层归一，语义修正应在归一层做，处理器保持无差别消费。

## 后果

- 终态截断从此可见：用户看到错误而不是被截断的「成功」回答；部分文本仍保留在消息里。
- AI SDK 路径的未来未知 reason（如 Responses 新增截断码）仍按旧行为处理，由 native 路径精确覆盖——已知限制，非缺陷。
- `finish-step` 之后流断的场景不再双记账；正常流断估算行为不变。
- 验证：llm 包 54 pass / 0 fail（incomplete 四态、usage 单次记账、工具轮不报错），opencode llm 两套件 49 pass / 0 fail（adapter 追加 provider-error、interrupted 不报、估算守卫三态），两包 typecheck 通过。全部离线 fixture，无真实供应商调用。

模型可见四问：

1. 正常完成与 `interrupted` 的模型输入输出零变化；变化仅在终态截断时会话以错误收尾（错误文案到客户端，模型本身不再收到续跑指令）。
2. 固定前缀零增量；无新增注入段。
3. 不改缓存布局与 revision 结算；错误收尾使该轮之后的续跑由用户显式发起。
4. provider-error 文案有界：reason 码白名单 `[a-z0-9_-]`、超长/异形折叠为 `unspecified`，上限 64 字符；无秘密内容。

回链：`packages/llm/src/protocols/openai-responses.ts`（onResponseFinish 注释）、`packages/opencode/src/session/llm/ai-sdk.ts`（finish-step 注释）、`packages/opencode/src/session/llm.ts`（estimatedFinishEvents 注释）。
