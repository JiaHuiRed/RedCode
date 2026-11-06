# 上游丢弃 tool call 的可见性兜底

状态:implemented

## 问题

opencode-go/glm-5.3-flash 连续多轮出现同一形态：思考链里明确「立即执行」，正文以冒号结尾（「这次真的动手，先把上两轮说好的修补落到 prompt.ts：」），随后 `finish=stop`、工具 part 为零。usage 的 output tokens 比可见正文多出 320~880，但差额可能包含隐藏推理，不能证明被丢失的内容或数量。客户端没有任何 tool-call 事件（日志无 `llm.tool-input`），用户观感是「宣布完就停」。

同会话另有一条 reasoning 与 text 逐字相同（各 2501 字符、分别计费 1187/853）：上游把同一段思考同时写进 `reasoning_content` 与 `content`。该形态不参与本判据（正文不以冒号结尾）。

## 决策

判据只认「正文以冒号结尾 + 零工具 part（含供应商执行的工具）+ `finish=stop`」，不拿 token 差额当门槛。冒号并不能证明是动作预告，正常回答也可能命中。

- **备选 A**：按 `outputTokens - 可见文本估算 ≥ 300` 判定。否决——实测 step-3.7-flash / step-5-preview 的 usage 普遍比可见文本大几百到上千 token（正常回答也如此），全库按差额判定会命中 586 条，绝大多数是误报。
- **备选 B**：同时要求正文长度 < 500 字符。否决——step-3.7-flash 的正常短回答同样落在这个区间（out 405~1347、text 86~355），仍无法区分。
- 历史样本中按「冒号收尾」形态有 12 条命中；这不排除其他正常冒号结尾的误报。

命中后先注入一次续跑提示（`OutputLoss.RECOVERY_PROMPT`，作为临时 request tail，不落库），限一次；再次命中则落可见说明，明确可能正常结束（`OutputLoss.notice`，写入 assistant 消息的 text part）。

## 后果

- 模型可见输入只在异常路径变化：命中时追加一条约 60 token 的系统提示；正常路径零变化，前缀与 KV cache 不受影响。
- 注入的提示与可见说明都是有界常量（< 1KB）。
- 续跑一次会额外消耗一轮额度；这是「上游可能连续丢」与「静默停下」之间的取舍，上限由 `outputLossRetried` 钉死。
- 识别签名：`finish=stop` + 零工具 part + 最后一条可见 text 以 `：`/`:` 结尾；日志事件 `output.loss.recover` / `output.loss.dropped`。

实现与回归入口：`packages/opencode/src/session/output-loss.ts`、`packages/opencode/src/session/prompt.ts`、`packages/opencode/test/session/output-loss.test.ts`。
