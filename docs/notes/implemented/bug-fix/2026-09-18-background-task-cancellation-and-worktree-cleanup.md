# 后台隔离任务可取消并在保留期后回收

状态: implemented

## 问题

`task_status` 之前只有轮询和等待参数，等待超时只是返回结果，后台任务仍继续运行；而
`BackgroundJob.cancel()` 已存在却没有工具入口。错误委派或卡住的隔离子代理因此会持续占用模型、
MCP/LSP 子进程和 worktree。

成功任务的 worktree 仅在下一次创建 worktree 时顺手扫描过期目录。实际 `data/worktree` 已有
21 份、约 2.45 GiB；sidecar 若之后不再创建 worktree，超过七天的目录也不会被主动处理。

## 决策

- `task_status(cancel: true)` 经 `BackgroundJob.cancelTree()` 取消目标 job 及按 session 关系匹配的
  嵌套 background job；`SessionRunState.cancel()` 复用同一棵取消树。它不把单纯 `wait` 超时视为取消。
- 隔离任务失败或被中断时，先由 `runIsolated` 的 existing finalizer 释放 InstanceStore 和子进程，
  再以不可中断的 cleanup 移除 worktree。
- 隔离任务成功时仍保留 worktree 七天供检查和手动合并；完成后在 parent instance scope 安排一次
  `Worktree.remove`，不再依赖下一次创建任务才触发。进程重启前未到期的目录仍由创建路径的既有
  `reap()` 兜底。

`task_status` 的模型可见变化只有一个固定的可选 `cancel` 布尔参数和一行说明；固定 system prefix
不变，工具定义的既有尾部增加该参数，因而不移动其他工具或注入段。没有新增模型可见数据源，
也没有无界输入。

## 备选与否决理由

- **把 `wait` 超时改为自动取消**：否决——轮询者经常只是暂时不等待，自动中断会破坏仍在执行的合法任务。
- **只调用 `BackgroundJob.cancel()`**：否决——不会按 session 关系收口嵌套 job。
- **成功后立即删除**：否决——`task` 输出的 worktree 路径是检查和合并子代理产出的通路。
- **仅保留创建时的 opportunistic reap**：否决——没有后续创建时，过期目录没有回收时机。

## 后果

取消会等待失败路径的 Git worktree 移除完成，最坏受既有 Git 子进程超时约束；这以一次取消较慢
换取不留进程和目录残骸。成功 worktree 在 sidecar 连续运行时到期主动删除；sidecar 重启会中断
未到期的延时 fiber，随后首次创建 worktree 时的既有扫除仍会删除过期目录。
