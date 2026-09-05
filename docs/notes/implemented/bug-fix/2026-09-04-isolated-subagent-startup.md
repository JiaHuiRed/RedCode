# 隔离子代理启动失败时收口生命周期

状态:implemented

## 问题

TUI 的 `task` 工具同时收到 `background=true` 和 `isolation="worktree"` 时被参数保护直接拒绝，无法异步运行隔离子代理。移除保护本身也不安全，因为后台 job 原先只执行 `runTask()`，会把子代理留在 parent instance 中。

隔离 worktree 的初次 `git reset --hard` 与普通本地 Git 命令共用 120 秒上限。大仓在 `--no-checkout` 后填充数万文件可能超过这个时限；超时会留下未完整填充的 worktree 和 Git 的 `index.lock`。创建流程原先没有清理 boot 失败的已注册 worktree。

snapshot 只用进程内信号量保护同一个 snapshot gitdir。多个 RedCode 进程可以同时运行 Git 操作，崩溃后的 Git `index.lock` 也不应由应用无条件删除。

## 决策

- background + worktree 由同一个 `BackgroundJob` 承载，后台 effect 内部调用 `runIsolated`，完成输出保留 worktree 目录和分支信息。
- 初次 checkout 使用独立的 10 分钟 `CHECKOUT_TIMEOUT`；其他本地 Git 命令仍保持 120 秒边界。
- boot 返回失败或缺少实例时，复用 `Worktree.remove` 尽力清理已注册 worktree；清理失败只记日志，不覆盖原始创建失败。
- snapshot 在原有进程内信号量外增加 `Flock` 跨进程锁。Flock 自身支持心跳和崩溃恢复，但实现不自动删除 Git 的 `index.lock`。

## 备选与否决理由

- **继续拒绝 background + worktree**：否决——这正是异步隔离任务无法启动的用户可见失败。
- **只删除参数保护**：否决——后台路径会执行未隔离的 `runTask()`。
- **把所有 Git 命令的时限都改成十分钟或取消时限**：否决——会扩大永久挂起的影响面；已有超时决策要求只放宽合法的大仓路径。
- **发现旧 `index.lock` 就直接删除**：否决——无法排除另一个 Git 进程正在使用它，且会掩盖进程/锁生命周期问题。

## 后果

后台隔离任务现在可以进入真实 worktree 生命周期，创建完成后的 worktree 仍按现有语义保留。初始化失败的 worktree 会通过已有 Git 清理路径回收，原始错误仍会返回或记录。

snapshot 操作在多个 RedCode 进程之间串行，竞争者最多等待 Flock 的有界默认时限；Git 自己留下的锁仍会以 Git 错误暴露，不能依赖应用静默删锁。识别这类故障时应区分 `Flock` 锁和 `<gitdir>/index.lock`。
