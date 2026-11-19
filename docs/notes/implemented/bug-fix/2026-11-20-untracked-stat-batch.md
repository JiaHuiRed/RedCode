# 未跟踪文件行数统计与补丁生成的跨运行时修复

状态:implemented

## 问题

2026-11-20 Windows 审计在固定版本源码上复现了两个独立缺陷，都落在未跟踪文件路径：

1. **行数统计跨运行时失效**。`Git.statUntracked` 直接 `Bun.file(path).arrayBuffer()`。TUI 在 Bun 下正常；桌面 sidecar 是 Electron 的 Node utility process，Bun 未定义，调用抛错后被 catch 成 `undefined`，`Vcs.status` 再把空值转成新增 0 行——同一个三行新文件，Bun 下 +3，Node 构建下 +0。
2. **32 MiB 上限在读取之后**。即使读取成功，`arrayBuffer()` 已把整份文件读进内存，之后才判断 `byteLength > 32 MiB` 并丢弃。128 MiB 样本的统计函数读取正文 128 MiB、峰值 RSS 160.4 MiB；先查大小的对照是 0 B / 31.8 MiB。
3. **未跟踪补丁逐文件起进程**。`vcs.diff` 对每个未跟踪文件各跑一次 `git diff --no-index`，普通接口预算 60 个，raw 接口遍历全部。审计本地 257 个 12 行文件：逐文件 387.2 ms，批量 9.2 ms。

## 决策

**行数统计**：改用 `node:fs/promises` 的 `open` + `stat` + 分块读（64 KiB）。先 `stat` 判 32 MiB，超限直接返回 `undefined`，正文零读取；读取中增长也受同一预算约束。保留前 8,000 字节 NUL 检测、CRLF 与末行无换行计数。Bun 与 Node 两个运行时同形，不再分支。

**批量补丁**：新增 `Git.patchUntrackedBatch(cwd, files)`。每次请求分配独立临时 `GIT_INDEX_FILE`，`read-tree --empty` → `add -N`（NUL 分隔 pathspec）→ 一次 `git diff`。临时索引里只有这批文件，diff 不再带 pathspec。任何一步失败返回 `undefined`，调用方按原逐文件路径回退。`vcs.diff` 与 `diffRaw` 都优先走批量；逐文件 60 个的预算只作为回退兜底。

## 备选与否决理由

- **Bun / Node 双实现分支**：否决——两份计数逻辑会漂移，且下次任一侧改动都可能再漏。
- **把路径拼进 argv 传给 `git diff`**：否决——Windows `CreateProcess` 32K 上限，257 个中文路径会伪装成 spawn 失败。
- **`git diff --pathspec-from-file`**：实测本机 git 不支持（`invalid option`），只有 `git add` 支持；临时索引隔离已经能达到同样效果。
- **整批失败后继续用部分结果**：否决——补丁与文件对应关系不可靠，宁可整批回退逐文件。

## 后果

- 桌面端未跟踪文件的新增行数恢复正确；大文件统计不再读正文。
- 普通 diff 与 raw 的未跟踪补丁进程数从 O(文件数) 降到 O(1)（失败时退回 O(文件数)）。
- 临时索引由 `Effect.ensuring` 清理；并发/取消不碰真实索引。测试断言批量后 `git status` 仍全部 `??`。
- 无 HEAD 的仓库仍走逐文件回退（`track` 无 ref 分支），这是保守路径，不再是主要开销。
- 验证：redspace typecheck 通过；`test/git/git.test.ts` 11 pass（含 CRLF/空文件/二进制/批量补丁与索引不变用例）、`test/project/vcs.test.ts` 12 pass。
