# 忙碌引导待消费形态与打断发送

状态：implemented

## 问题

忙碌时的引导（steer）旧路径是直接落库 `delivery: "steer"`——用户点击发送后就失去了对这条消息的一切控制：不能编辑、不能撤回，即使发现写错也只能等模型消费完再纠。同时 GUI 想在忙碌时「停下当前 + 立即执行新指令」只能自己串 abort + prompt 两个 HTTP 请求，中间存在时序竞争（abort 未完成时 prompt 可能撞上旧轮收尾）。

## 决策

1. **`pending_steer` 待消费形态**：忙碌引导落库为 `pending_steer`——进消息流（用户可见、可编辑/撤回），但对模型隐藏，直到 loop 组装前 `promotePendingSteer` 领取转 `steer`。busy 判定以服务端 Runner 为准（`SessionRunState.isBusy`），不信客户端快照。
2. **三处排除 + 一处领取**：未领取的 pending_steer 从模型可见性过滤（`visibleMsgs`）、`MessageV2.latest`、reminder 收集三处排除。`visibleMsgs` 的排除防的是 promote 之后、投影读取之前新引导落库的窗口竞态；promote 与编辑/撤回共用 queueLock 串行——编辑先落盘则领取转发编辑后文本，领取后编辑明确冲突（`QueuedMessageConflict` → HTTP 409）。
3. **提交方重跑闭环兼容**：提交方 loop 的重试检查（`delivery !== "steer"`）天然覆盖 pending_steer（不等于 steer 即重跑），旧轮收尾后重跑 loop 首步 promote 领取，引导不丢。
4. **`interruptPrompt` 服务端入口**：`POST /session/:id/interrupt_prompt`，单请求内 `cancel → 提交 → 起新 loop`。`Runner.cancel` 置 Idle 但不等旧 fiber 尸体清理——足够：旧 loop 中断后不再组装请求，新消息不会被旧轮吞；UI 的「正在中断」由 status 事件驱动（idle → 新 busy），不需要服务端加强等待。新 delivery 强制普通（开新轮）；此前未领取的 pending_steer 由新轮首步 promote 一并领取，引导内容不丢。不碰 Git 快照、不回滚工作区文件。
5. **TUI/GUI 提交面**：TUI 忙碌默认 steer（原硬编码 queue；`onQueue` 死代码删除，`/pending` 同时管理两形态）；GUI 忙碌+非空输入时显示「打断并发送」按钮，`runSubmit(intent)` 参数化共用整条提交流水线，只在 API 调用处分流。

## 模型可见四问

1. **模型看到什么变了**：待消费期间（pending_steer）引导完全不在请求里（旧路径 busy steer 立即进历史 + reminder）；领取转 steer 后与旧 steer 行为一致——消息进组装、reminder 以既有格式注入（`<system-reminder>The user sent the following message: …`）。打断发送的新轮组装与普通消息无异，无新增提示词或格式。
2. **token 影响**：固定前缀（system/tools）零变化；每条待消费引导在其未领取期间不占模型上下文（相比旧路径是节省）。reminder 注入沿用 260729 的轮起点边界与去重，无重复提醒。
3. **KV cache 影响**：领取发生在某步组装前，该步起消息数组尾部变化——与既有 steer/queued 消费相同的缓存影响面（尾部追加/截断），无全前缀作废的新来源。打断发送取消旧轮后新轮从既有历史组装，尾段重建。
4. **注入项上限**：无新增注入项。reminder 文本沿用既有收集逻辑（每条引导文本 + 固定包裹，长度受消息本身约束，去重防重复注入）。

## 验证

- 引擎：`test/session/prompt.test.ts` 113 pass（新增 3 条：pending_steer 生命周期、busy 端到端落库/隐藏/领取、interruptPrompt 取消+单次执行；task steering 4 变体断言更新为 pending_steer 中间形态）；opencode 与 app typecheck exit 0；`check:openapi-drift` exit 0；submit.test.ts 13 pass。
- httpapi coverage：`session.interrupt_prompt` 场景与 `llmScenarios` 登记已加（套件级三连验证因耗时被跳过，场景与 prompt 端点同构）。
- 真机验收（webqa + 真实 GLM 会话，五条全过）：① 忙碌引导落 pending_steer → promote → delivered，模型回复响应引导内容（「数完告诉我总数」→ 给出 325/7260 两个总和）；② dock 编辑保存后模型消费**编辑后文本**（「数到 1000 就停」编辑为「数到 500 就停」→ 模型数到 500 停下并验算总和 125250）；③ 已领取消息编辑 API 返回 409；④ 打断发送：旧轮 assistant finish=None（真中断）、新消息普通 delivery、新轮请求恰一次；⑤ UI 无新轮次入口（message-part 不感知 delivery，回滚按钮不入发送链路）。

## 边界

- `interruptPrompt` 的 handler 为 fork 后台执行（返回 204），客户端通过 status 事件观察「正在中断 → busy」；深度的「旧工具进程退出前新轮已启动」窗口与既有 cancel 语义一致（cancelTree 异步收尾），未加强等待。
- 打断发送的「不回滚」与 revert 按钮独立：回滚仍是消息流上的单独操作，不在发送链路。
