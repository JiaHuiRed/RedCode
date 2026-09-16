# Sidecar health wait has an explicit success/failure contract

状态: implemented

## 问题

`spawnLocalServer()` 原先返回一个 `health.wait` promise。轮询超过内部 deadline 后会正常 resolve，而初次启动又把 30 秒 timeout catch 掉，因此后续仍会记录 `sidecar healthy`，形成“未健康但走成功路径”的第三种状态。

## 决策

- `HealthCheck` 暴露 `waitUntilHealthy({ timeoutMs? })`，只有健康探针成功才 resolve。
- 探针 deadline 到达或 sidecar 已退出时 reject，并保留失败原因。
- 初次启动不再吞掉 rejection；它进入既有 `loadingTask` 失败处理并记录启动失败。
- respawn 将 rejection 映射为 `healthy: false`，不清零连续失败计数；不重写现有 respawn 生命周期。

## 备选与否决理由

- **保留 `Promise<void>` 并让调用方自行猜状态**：否决——正是当前伪成功日志的来源。
- **顺手重写 sidecar supervisor**：否决——本次只修 health contract，避免扩大生命周期改动面。

## 后果

启动阶段超过 30 秒仍未通过健康检查会明确失败并退出，不会把不可用服务交给 renderer。respawn 仍沿用原有策略，失败结果会被日志明确标成 `healthy: false`。
