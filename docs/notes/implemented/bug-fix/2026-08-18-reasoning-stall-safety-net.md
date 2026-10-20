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

## 2026-10-20 更新：判据换代（字符量 → 静默时长）

### 复盘：上一版把「想得多」当成了「卡死」

字符阈值上线后，在 max 推理档上开始稳定误杀正常长思考。数据库实据（近十天，四个模型共 **53 次**，正文分片长度精确落在 30,000–30,015 字符、`finish=stop`、output token=0，即提升路径的指纹）：

| 模型 | 命中次数 | 时间跨度 |
| --- | ---: | --- |
| step-5-preview | 28 | 10-07 → 10-15 |
| glm-5.3-flash | 10 | 10-09 → 10-13 |
| deepseek-flash | 9 | 10-07 |
| step-3.7-flash | 6 | 10-06 → 10-08 |

原判断「3 万字符是正常思考量的 8 倍余量」用的是 step-3.7-flash 约 3.5K 字符的样本；现在模型的思考长度已经上了一个量级（中文约 2 字符/token，3 万字符只有 ~1.5 万 token，而 deepseek-flash 单条最高已跑到 17,366 推理 token）。**判据的前提变了，结论就得跟着变。**

同时确认不是输出上限：`maxOutputTokens` 自 260824 起按模型目录推导（本机 glm-5.3-flash = 128,000、step-5-preview = 65,536、deepseek-v4-flash = 65,536–128,000），实测请求体 `max_tokens=128000`；同期这三个模型 `finish=length` 计数为 0。

### 新判据

1. **主判据：静默时长** `Stream.timeoutOrElse({ duration: idleMs })`——供应商在 `idleMs` 内不再吐任何分片才算卡死。计时只覆盖「等上游下一个分片」的时间，`tap` 里执行工具时上游并未拉取，长工具不会被误判成静默。这绕开了当初否决 wall-clock 的理由（慢但持续吐字不算卡）——被否决的是「总时长」，不是「最长静默」。
2. **兜底：字符量** 单 step reasoning 累积到 `maxChars` 仍未产出 text/tool 才切断，专治「永远吐字但永不收尾」的无限流。
3. 两条路径统一走 `promoteReasoning(reason)`，处理链与原版一致（剥离注入复述 → 提升为可见正文 → 收尾 reasoning part → `finish="stop"` 落库 → 停流）。
4. 只有「有思考无产出」才提升；纯静默且零思考时只结束流，交给 prompt.ts 的 `producedNothing` 恢复链（260808）出可见说明。

两个阈值都由配置拥有方解析（`config/reasoning-stall.ts`，`experimental.reasoningStall`）：`idleMs` 默认 300,000（5 分钟完全静默），`maxChars` 默认 200,000。此前是硬编码常量，违反「可调项必须能从配置改」。

### 代价

- 无限流形态的切断点从 3 万字符抬到 20 万字符：真的无限吐字时，会多烧约 5–6 倍 token 才被兜住。这是「让正常长思考不被误杀」必须付的对价。
- 纯静默（零分片）现在也有出口（idleMs 后结束流）；在此之前它和「无限流」一样会挂到用户手动中断。

### 验证

- `processor-effect.test.ts` 22 用例全绿：字符兜底用例改为配置压到 30,001 复测原路径；新增 idle 用例（mock `hang()` 永不发 done 哨兵，500 字符思考后静默，`idleMs=1500`）断言提升 + `finish="stop"`。
