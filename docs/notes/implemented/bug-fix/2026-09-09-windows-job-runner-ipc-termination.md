# Windows Job runner 终止 IPC 失败时主动收敛

状态:implemented

## 问题

Windows Job runner 的父进程在检查 `connected` 后发送 `terminate`，IPC 仍可能在竞态窗口内同步抛错，或通过 callback 异步报告失败。原实现忽略了这两种失败，runner 可能继续存活，调用方的 `exited` 结局也不确定。runner 侧的 `process.send` 也有同样的连接竞态；同步异常会把发送 Promise 变成未处理 rejection。

## 决策

`packages/opencode/src/util/windows-job.ts` 集中发送终止请求，使用 callback 观察异步失败，并在同步或异步失败时 `SIGKILL` runner。`packages/opencode/src/util/windows-job-runner.ts` 捕获 `process.send` 的同步异常并返回失败状态，让既有的失败收敛路径结束 runner。

## 备选与否决理由

- **只依赖 `connected` 检查**：否决——检查与 `send` 不是原子操作，无法覆盖竞态。
- **忽略发送失败，等待超时**：否决——会把可立即判定的 runner 故障变成无界等待。
- **整体移植 DSH subprocess-local**：否决——那套实现还包含独立的 runner 协议、跨平台托管范围和可执行文件解析，超出 RedCode 当前修复边界。

## 后果

正常终止路径不变；runner IPC 已关闭或发送失败时会更快进入现有 `error`/`close` 处理。`SIGKILL` 只作用于私有 runner，不直接扩大到其他进程树。回归验证使用 `bun run typecheck` 与 `test/util/process.test.ts`、`test/mcp/stdio.test.ts`。
