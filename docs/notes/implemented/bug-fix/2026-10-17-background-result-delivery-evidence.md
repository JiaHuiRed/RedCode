# 后台结果回传失败不能覆盖子任务执行结果

状态: implemented

## 问题与证据

审计 SA-04 指出 `inject(...).pipe(Effect.ignore)` 的可观测性缺口。故障注入先证实普通失败不会发出回传警告，结果仍可经 `task_status` 查询；沿实际调用链核对后，又确认了更重要的错误通道差异：

- `session/prompt.ts` 的 `SessionPrompt.ops()` 用 `catch(Effect.die)` 将 prompt 错误转换为 defect。
- 本仓 Effect v4 的 `ignore` 只处理 typed failure，不处理 defect。不能凭名字把它当成“所有失败都忽略”。
- 向父会话写入时抛出 defect，会进入子任务的外层 `catchCause`：成功子任务被误标为失败，原本失败的子任务错误也会被父会话写入错误替换；Explore 的 canonical result 同样可能被改写。

红测分别断言成功任务的 `job.error` 应为空、失败任务应保留原错误，旧处理下却收到 `injected parent write failure`。这不只是通知缺失，也不是已经证明的永久数据丢失。

## 决策

- 只在 `deliverResult` 的结果投递边界处理失败，成功与失败回传共用同一入口；不改派发、子任务运行或父会话续跑机制。
- 非取消的投递失败记录一条 `Log.warn`，仅带父会话 ID、子任务 ID、原执行状态；不记录结果或异常正文。随后发出既有 Toast 通知，不覆盖子任务原有 output/error 和 canonical result。
- 提示使用“无法确认投递”，让用户先检查父会话，缺失时再以明确 task ID 调用 `task_status`。`SessionPrompt.prompt` 在写入消息后还会 `sessions.touch`，后一步失败不等于消息完全没保存。
- 纯 interrupt 原样传播，仍按既有取消路径收尾，不误报回传失败。通知总线本身失败时，已有持久日志作为证据，不让通知错误覆盖任务结果。
- 不重试注入、不二次执行子任务、不新增消息队列或投递状态 schema；恢复仍受既有 job 保留与子会话历史约束，不承诺无限保留。

## 没有改动的机制

真实父会话消息写入测试证实：成功/失败结果均只保存一次；父会话繁忙时结果已经保存，空闲后才自动续跑；持续繁忙超过原有期限会提示等待，已保存结果可以手动继续。这些路径没有发现需要修复的缺陷。

期限测试使用注入时钟模拟墙钟跳过 31 分钟，再推进一个 300ms tick，不实际等待，也不为测试运行六千次数据库轮询。生产超时与配置不变。

## 验证与边界

- Execute（旧别名 general）与 Explore × 成功/失败/投递取消，共六个故障用例，检查原结果、原错误、canonical record、仅执行/投递一次、无意外续跑和 warning 数量。
- 三个父会话实际持久化/续跑集成用例，正常子任务经本地 TestLLMServer 执行，失败从子执行边界注入；不调用真实模型。
- 回归范围为 task、task_status、task-runtime、capability，以及 prompt 中相关后台/steer/子任务用例，不跑全量测试。
- 最终结果：四份 task 类定向文件 50 pass、174 expects；prompt 相关六项 6 pass、35 expects；opencode typecheck、版本一致性和 `git diff --check` 通过。
- 未重编或重启安装版，未做 GUI 实机通知截图，不宣称解决进程退出后的全部恢复问题。

模型可见四问：提示词、工具 schema 和合成结果正文均不变；固定前缀 token 增量为零；工具表与 KV cache 布局不变；无新增模型上下文注入项。新增 Toast 是固定文案加生成的任务 ID，仅供客户端显示；日志不含结果、命令或异常正文。
