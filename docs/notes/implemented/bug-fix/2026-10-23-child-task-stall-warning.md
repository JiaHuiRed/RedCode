# 子代理卡死只警告不终止，cancel 归位残留状态

状态: implemented

## 问题

261023 实测（本会话）：execute 子代理的模型（GPT-6 Luna）额度耗尽后，任务表 running 长达 27 分钟。链路是网关错误被判可重试（`SessionRetry.retryable` 的 rate-limit 模式），无 `retry-after` 头时每次挂满首事件超时（75s）再退避，有头时单次放行最长 10 分钟（`RETRY_MAX_DELAY = 600_000`）——重试上限 10 次意味着最坏可挂约 100 分钟。期间主对话用 `task_status` 轮询只能看到 "Task is still running."，attempt 数、重试原因、持续时长全部不可见，无法判断该不该取消；主对话只能盲目续等（实测连轮三次共 9 分钟空转）。

连带两个缺口：

1. `task_status(cancel: true)` 中断 job fiber 后，processor 收尾的 `status.set(idle)` 在被中断的 fiber 里跑不到，SessionStatus 状态表残留 busy——TUI 的"等待模型响应"spinner 读的就是它，任务表 cancelled 了、视觉上还在转（261023 实证，用户截图）。
2. busy/retry 状态没有时间起点，"这个任务在同一状态卡了多久"无从计算。

## 决策

**警告与终止分离**（用户明确要求"发警告，但不强行终止"）：

- `SessionStatus` 的 busy/retry 增加 `since`（状态段起点毫秒）。打点收在 `set()` 内部：同类型重写保留段起点（retry 每个 attempt 重写一次，段起点即重试循环开始），类型切换开新段，新段尊重调用方显式 `since`（生产写入方不传）。四个写入点（processor/prompt/run-state）零改动。
- `task_status` 输出在运行态追加两类信息：retry 段带 `attempt N/10` 与原因；同一状态段超过 `experimental.childStall.warnMs`（默认 360000，范围 30s–1h）追加警告段，明写"长工具/长推理也会这样，疑似额度或限流卡死可 `cancel: true`"。等待中（wait=true）超时返回与主动轮询两条路都自然携带，不加定时器、不加新事件通道。
- `BackgroundJob.cancelTree` 返回被取消的任务 id 列表；`task_status` 的 cancel 分支据此把遗留的 busy/retry 归位 idle，TUI spinner 随之停止。
- 阈值进配置（`config/child-stall.ts`，与 reasoningStall/toolInputGuard 同惯例），不硬编码。

## 备选与否决理由

- **超限自动取消**：否决——用户明确要"警告不强杀"；长工具（bash 600s）、长推理、权限等待都会超 6 分钟，自动终止的误杀代价远高于多看一眼警告。
- **向主对话推送警告事件**：否决——主对话本来就在轮询或等待，`task_status` 输出附加即可覆盖两条路径；新事件通道要动 bus/前端，收益不成比例。
- **按"最后输出事件时间"判静默**：否决——需要在流事件层埋点到状态层，改动面大；状态段时长已覆盖本次场景，且警告误报的代价本来就低。

## 后果

- 长工具/长推理/权限等待超过阈值会触发一次警告，文案已写明可能是正常行为，判断权在主对话。
- 残留状态清理只挂在 `task_status` 的 cancel 路径；run-state 自己的 cancel 流程有独立的 idle 归位，不受影响。
- `task_status.md` 描述加一句警告说明（模型可见）：工具描述属系统前缀 tools 段，该段起前缀作废一次，下次请求重建；警告文本本身只出现在工具输出，无固定前缀影响，格式固定有界。
- 识别签名：`task_status` 输出出现 `Warning: this task has been in "busy"/"retry" for ~N min`——若频繁出现在短任务上，说明阈值偏低或状态段被反复重写（打点逻辑回归）。
