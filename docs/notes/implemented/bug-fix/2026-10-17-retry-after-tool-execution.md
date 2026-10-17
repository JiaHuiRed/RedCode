# 工具执行后断流不再自动重试

- 日期：2026-10-17
- 状态：implemented
- 相关：`packages/opencode/src/session/retry.ts`、`packages/opencode/src/session/processor.ts`

## 背景

`processor.process()` 在每次 step 开始时记录已有 part 的 baseline，重试时删除 baseline 之后新建的全部 part，再重放同一个 `streamInput`。删除时不区分 text/reasoning 与 tool part。

AI SDK 会在 `tool-call` 事件之前就启动 `execute`（`processor.ts` 的 `updateToolCall` 注释记录了这一点），所以断流时工具可能已经产生了副作用：追加写文件、执行命令、创建远端对象。

重放后模型看到的是原始请求，看不到刚才的调用结果，于是再发一次同样的调用——对非幂等操作就是执行两遍。

## 决策

只要本 step 已经产生过 tool part（`ctx.toolsStarted`），重试策略就返回 `Cause.done`，停止自动重试。错误走原有的 `halt` 路径：本轮以错误结束，已落库的工具记录**保留**，用户重发下一条消息时模型能读到这些结果继续。

工具尚未出现的失败（首事件超时、纯文本流中断、5xx）保持原有重试行为，重放是安全的。

判定放在 `SessionRetry.policy` 的可选参数 `toolsStarted?: () => boolean`，由 processor 传入闭包——策略层不碰会话状态，也便于单测。

## 备选

- **续跑：把已完成的工具结果拼回 messages 再请求**。理论上是文档建议的方向，但要手工构造 assistant tool-call + tool-result 序列，处理与 step 语义、计费、压缩投影的交互，风险显著高于当前收益。留作后续；实现前需要先解决"部分工具完成、部分未完成"的消息配对。
- **按参数去重**：相同参数可能是两次合法操作，不可靠。
- **完全不自动重试**：会牺牲最常见场景（工具尚未执行的断流）的自动恢复，代价过大。

## 后果

- 工具执行后的断流不再自动恢复，用户会看到一次错误，需要再发一条消息继续。这是有意的取舍：正确性优先于自动恢复。
- 本路径不删除任何 part，因此不会再出现"消息级费用已累加、汇总时又扣回"的歧义。
- 粒度为"本 step 是否出现过 tool part"，对并行工具批同样保守（一个 part 建出来就整体不重试）。
- 识别签名：日志里工具已 completed 但同一 step 出现 `retry` 状态 → 如果是本 note 之前的行为，说明修复未生效。
