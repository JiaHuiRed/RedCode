# 隔离 worktree 的写入边界改成硬拒绝，并把 shell 里的 git 钉在 worktree 上

状态:implemented

## 问题

`task` 工具的 `isolation: "worktree"` 此前只做一件事：把子代理的默认 cwd 换到新建的 worktree，并把 `InstanceRef` 换过去。它**不约束写入目标，也不约束提交目标**——模型只要在 prompt 或自己的推理里拿到父工作区的绝对路径，`write` / `edit` / `apply_patch` 就能直接改父工作区的文件，`git -C <父仓库> commit` 也能把改动提交进主仓库。

实证：2026-09-13 并行派出的多个 execute 子代理写穿了各自的 worktree，直接在主工作区抢着 commit，产出四个互相污染的 commit（其中 `b2277c794` 这类只有测试文件没有实现体）。清理靠 `git reset --mixed` 回基线加逐项重建，产出被保留在备份分支里。

注意 `assertExternalDirectoryEffect` 当时**已经存在**并在越界时 `ctx.ask("external_directory")`——但"询问"在权限配置宽松、或编排方不在场（子代理自动批）时拦不住任何东西。护栏需要的强度是拒绝，不是询问。

## 决策

两段护栏，都只在隔离 run 内生效：

1. **写侧硬拒绝。** 新增 `IsolationBoundaryRef`（`src/effect/instance-ref.ts`），`runIsolated` 在子代理运行期间把它设成 worktree 根。`assertExternalDirectoryEffect` 增加 `write?: boolean` 标记：隔离 run 中目标落在边界外时直接 `Effect.die` 拒绝，不再走 `external_directory` 授权。`write.ts` / `edit.ts`（两处）/ `apply_patch.ts`（两处）全部传 `{ write: true }`。**读操作不拦**——子代理读父工作区代码是正当需求，保持原有询问语义。
2. **git 侧钉住。** `shellEnv` 在边界存在时注入 `GIT_DIR=<boundary>/.git` 与 `GIT_WORK_TREE=<boundary>`。实测（`git worktree add` 的 gitfile 形态）：`GIT_DIR` 会压过命令行的 `git -C <父仓库>`，`rev-parse --show-toplevel` 返回 worktree 路径，因此 `add` / `commit` 落不到主仓库 index。

第一段代码注释里的 `// 260913 Red ...` 即本条回链；实现见 `packages/opencode/src/tool/external-directory.ts`、`packages/opencode/src/tool/shell.ts`。

## 备选与否决理由

- **只在权限系统里把 `external_directory` 默认改成 deny**：否决——影响所有会话的所有工具调用，为了一个只在隔离 run 里成立的约束付全局代价；而且询问语义对普通会话是有用的（用户确实想授权某个外部目录）。
- **不注入 GIT_DIR，改为解析 shell 命令文本、发现 `git -C` 指向边界外就拒绝**：否决——命令文本可以拼接、变量展开、`cd` 后隐式生效，文本启发式必然漏；环境变量是 git 自己的机制，判断权在 git 而不是我们。
- **把 worktree 做成 chroot / 只读挂载父仓库**：否决——跨平台代价过高（Windows 无原生 chroot），且要改启动链。
- **拦截所有工具而不只是写类工具**：否决——读父工作区是隔离子代理的常见正当行为，拦下来只会逼模型用 shell 绕过。

## 后果

- 隔离子代理**无法**再修改父工作区文件，也**无法**把父工作区的改动提交进主仓库。这是设计意图，但意味着：如果子代理需要跨工作区协作（比如把结果写回父工作区），必须由父会话自己做，或在工具层显式放宽。
- 非隔离会话完全不受影响：`IsolationBoundaryRef` 为 `undefined`，所有分支短路，工具参数 schema 与提示词均无变化。
- 识别签名（防复发检查）：新增任何"写文件"工具时，必须调用 `assertExternalDirectoryEffect(ctx, target, { write: true })`；新增任何"执行 shell"的代码路径时，若它绕过 `shellEnv` 直接构造 env，就会丢掉 git 钉住——`test/tool/shell.test.ts` 的 "pins git to the isolation boundary" 用例是这条的回归锚点。
- 未覆盖：shell 里的文件重定向（`echo x > 父仓库/文件`）不在工具层可达范围内，仍然可以写父工作区文件（但提交已被钉住）。彻底封堵需要 OS 级隔离，不在本轮取舍内。
