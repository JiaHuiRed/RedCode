# 后台取消统一收尾：cancelTree 与 SessionStatus 归位下沉为共用服务操作

状态:implemented

## 问题

0.15.0 审计 RC-015-01（P1）：新增的 `POST /background/{jobID}/cancel` 直接调用 `BackgroundJob.cancelTree()`，只结束后台 job。而原有的 `task_status(cancel=true)` 在 `cancelTree()` 之后还会遍历被取消的 id，把 `SessionStatus` 里遗留的 busy/retry 重置为 idle。

原因是 fiber 被中断时跑不到 processor 收尾的 `status.set(idle)`（261023 已实证：任务表 cancelled 了、TUI 等待指示器还在转）。新入口复制了取消动作、漏掉了收尾，于是 TUI/GUI 后台面板点「终止」后，任务显示已取消、会话仍被当作忙碌。

## 决策

新增 `src/background/cancel.ts` 的 `BackgroundCancel` 服务，提供唯一取消入口 `cancelTree(id)`：

1. 调 `BackgroundJob.cancelTree(id)` 结束 job 树并拿到被取消的 id（job id 即 session id）；
2. 逐个会话读 `SessionStatus`，非 idle 的写回 idle（已 idle 不重复写，重复取消因此幂等）。

HTTP handler 与 `task_status` 工具都改调这个操作；`BackgroundJob` 保持纯 job 存储，不引入 session 语义。layer 装配在 `server.ts`（HTTP 路由）与 `tool/registry.ts`（工具执行）各补一条 `BackgroundCancel.defaultLayer`。

## 备选与否决理由

- **把归位逻辑塞进 `BackgroundJob.cancelTree`**：否决——job 存储层会反向依赖 `SessionStatus`，所有 job 使用方都被动获得 session 语义；以后出现非会话类 job 时会把无关 id 当会话写状态。
- **HTTP handler 里复制 `task_status` 的收尾循环**：否决——审计发现的问题正是「新入口各自复刻取消动作」，复制只会等第三次漏写。
- **让 `SessionRunState.cancel` 也改走共用操作**：本次不动——它对根会话的 idle 归位要与 `runner.cancel` 的时序配合（busy 时交给 runner 收尾，提前置 idle 会截断「正在中断」状态）。该路径的嵌套子会话归位是独立问题，留待单独评估。

## 后果

- 取消的幂等语义不变：不存在的 job 返回空数组，重复取消返回空数组。
- 非会话 job 若将来接入 `BackgroundJob`，取消时会对一个不存在的 session id 写一次 idle（只 publish 一条无人消费的状态事件）；当前只有后台任务 job 使用该存储，故不处理。
- 识别签名：后台面板取消后仍见 spinner，先查调用方是否绕过了 `BackgroundCancel.cancelTree`。
