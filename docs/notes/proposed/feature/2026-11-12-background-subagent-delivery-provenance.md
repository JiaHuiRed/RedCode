# 后台子代理交付的 provenance 与等待上限（低优先级）

状态:proposed

## 问题

对照 ZCode 的子代理文档后逐项核实，RedCode **已经具备大部分机制**：

- 不设固定墙钟：`tool/task.ts:445-448` 明确 task 层按整个子代理寿命计时会误杀长任务，
  request 级 stall guard 在 `session/llm.ts`（决策
  `docs/notes/implemented/bug-fix/2026-09-09-subagent-request-watchdog.md`）。
- 后台完成唤醒：`tool/task.ts:564-587` 的 `inject()` 写入 `noReply` 合成结果，
  `resumeWhenIdle()` 等父会话 idle 后 toast 并 `ops.loop` 续跑；30 分钟上限会发可见
  warning 而不是静默挂起（`task.ts:502-555`）。
- 等待与超时：`tool/task_status.ts:17-27` 的 `wait` / `timeout_ms` 由模型控制，
  默认 60s。

剩余的真实缺口只有两处，都属于小对齐，不是机制缺失：

1. **转后台 provenance**：`task.ts:429-434` 的 `metadata.background` 是启动时的布尔快照。
   如果任务从前台转后台（或反过来），迟到事件仍带旧标记。ZCode 要求每条事件发出时读
   runtime task registry 的当前状态（`docs/subagent-timeout-policy.md`）。
2. **交付确认语义**：`inject()` 成功只代表结果已写进父会话，`deliverResult` 的失败会
   toast 并提示用 `task_status` 恢复（`task.ts:591-608`）；没有 ZCode `TaskOutput` 那种
   `notified` 原子 claim。RedCode 用「消息写入即交付」的模型，本身没有重复通知问题，
   不需要照搬 claim，但可以在 UI 上明确「结果已落库」与「已续跑」两种状态。

## 决策

暂不单独立项实施，作为 `task` 工具的后续小修：

- 第一项（provenance）在真正出现「前台转后台后再收到迟到事件」的复现时再做；改动点是
  事件投影处读取运行时状态，而不是启动时快照。
- 第二项只做文档/文案层面的状态说明，不引入 durable mailbox、read receipt 或新的通知
  存储。

## 备选与否决理由

- **照搬 `notified` 原子 claim**：否决——RedCode 的交付载体是持久化消息，重复注入会被
  `inject` 的语义与消息 ID 约束，claim 解决的是 ZCode 的「通知队列」重复问题，不是
  RedCode 的问题。
- **引入完整 subagent mailbox / RespondToCoordinator**：否决——当前没有真实需求，属于
  产品级扩展，不值得为假想场景加状态机。

## 后果

- 本项保持低优先级，不阻塞其他两条。
- 如果后续出现「后台结果丢失/重复续跑」的真实故障，再按上面的两项分别修，并把本 note
  移入 `implemented/` 或 `rejected/`（取决于是否采用 provenance 修复）。
