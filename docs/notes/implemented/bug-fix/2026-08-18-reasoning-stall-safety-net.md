# reasoning 流级 stall 兜底：纯思考死锁不再挂死会话

状态:implemented

## 问题

2026-08-18 家用机 GUI 截图实测（step-3.7-flash）：模型卡死在思考链里——reasoning 无限流、正文/工具从未产出、`step-finish` 事件永不到达。表现：`Stream.takeUntil(() => ctx.needsCompaction)`（processor.ts）永不触发，`handle.process`（prompt.ts runLoop 内）永不返回，turn 永不结束，后续用户消息全部 QUEUED，只能 esc interrupt。

已有防线全部失效的原因：

1. **ngram 检测**（text-delta）：只在正文流上检测，reasoning 不检测。
2. **reasoningOnly 提升**（prompt.ts runLoop 下一轮）：前提是 `lastAssistant.finish` 存在——卡死时 finish 根本不存在（step-finish 事件没到），走不到。
3. **repeat-tool-reminder / doom_loop**：只管工具调用层，纯思考无工具可管。

## 决策

**在 processor 流内直接检测**：单 step 内 reasoning 累积超过 3 万字符且从未产出 text/tool，判定卡死。处理链：

1. 剥离注入指令复述（`stripInstructionEcho`，防 DCP reminder 之类的泄露跟着思考一起进正文）；
2. 思考文本拼接提升为可见 text part（与 runLoop 的 `reasoningOnly.promoted` 同款做法）——用户至少看得到模型在想什么，而不是对着一片空白等死；
3. 收尾 reasoning part（`finishReasoning`，设 end time、落库），与正常 step-finish 行为一致；
4. 置 `finish="stop"` 并**落库**（runLoop 下一轮的 break 条件读 `lastAssistant.finish`，只改内存对象会导致死循环重发请求）；
5. 停流（`takeUntil` 谓词加 `|| ctx.reasoningStallTripped`），`process` 返回 "stop" 走正常收尾路径。

阈值 3 万字符是正常思考量（step-3.7-flash 实测约 3.5K 字符）的约 8 倍余量，不会误杀正常长思考；`stepProduced` 标志在 text-start/tool-input-start 置位后即解除检测，reasoning→text 交替的正常流不受影响。

## 备选与否决理由

- **流级超时（wall-clock）**：否决——reasoning 流式速度受网络/供应商波动影响，时间阈值易误杀慢速正常思考；字符量是更稳的"想太多"判据。
- **只在 runLoop 加超时兜底**：否决——`handle.process` 是同步阻塞调用，外层无法中途干预流消费。
- **直接 abort 整轮（丢 reasoning）**：否决——用户看到的是空白，与卡死观感无异；提升为正文至少保留信息。

## 后果

- 测试：`processor-effect.test.ts` 新增用例——30001 字符纯 reasoning 流断言返回 "stop"、思考被提升为可见正文、finish 落库为 "stop"。14 用例全绿。
- 此兜底只治"reasoning 永流"这一形态；模型卡在"重复工具调用"或"空转打转"仍有 repeat-tool-reminder / doom_loop / maxSteps 兜底，互不重叠。