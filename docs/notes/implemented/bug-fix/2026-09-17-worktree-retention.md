# 隔离 worktree 的副本不回收

状态: implemented

## 问题

`task` 工具的 `isolation: "worktree"` 每跑一个子代理就建一份 git worktree，位置在
`~/.redcode/data/worktree/<projectID>/<随机名>/`。每个副本是**完整仓库检出（含 node_modules）**，
体积从几十 MB 到 1.5 GB。

而清理只发生在一条路径上：`worktree/index.ts` 的 `bootWithCleanup` 在 bootstrap 失败或返回空时调
`cleanupFailed` → `remove`。**成功跑完的副本没有任何人删**——`session/prompt.ts` 的 `runIsolated`
（205-225）跑完后只做 `store.value.dispose(ctx)`（释放 InstanceStore 缓存，让该 worktree 的 LSP 子进程
退出），不碰目录。

实测后果：本机 `~/.redcode` 共 11.6 GB，其中 `data/worktree` 占 9.5 GB / 36 个副本（6 个项目，最早可追到
6 月底），且没有任何上限——除了一次 `git worktree list` 之外毫无可见性。

## 决策

在 `worktree/index.ts` 加 `reap()`，在 `createFromInfo` 与 `createAndWait` 两个创建入口的最前面调用：
扫 `<data>/worktree/<projectID>/` 下的子目录，`mtime` 早于 `WORKTREE_RETENTION_MS`（7 天）的，逐个交给
现成的 `remove({ directory })` 处理。`remove` 会注销 git 注册、删 `redcode/<name>` 分支、停 fsmonitor，
并且能处理"注册已注销只剩目录"的残骸（`git worktree remove` 失败时它自己降级清目录）。

## 备选与否决理由

- **跑完立刻删**：会丢掉子代理的产出。`task` 的输出里会带上 worktree 路径（`isolatedOutput`），使用者
  可能回去检查或手动合并；立刻删等于把这个通路废掉。
- **进程启动时全量扫一遍**：需要新的启动钩子，而 server 的启动路径已有多个 init 竞争者；挂在"创建时"
  上零额外钩子，且触发频率天然与副本增长速度匹配。
- **只按数量上限（每项目 N 个）**：需要排序依据，做得并不比时间窗简单，且"最近 N 个"在慢项目上可能
  把还有用的删掉。
- **不回收、只加文档提醒用户手删**：私仓膨胀是持续性的，人不会记得；且用户无从知道 `data/worktree`
  的存在（`git status` 里看不到，它不在任何仓库里）。

## 后果

- 副本数量有上限：每个项目最多攒 7 天的量（取决于使用强度）。
- **窗口内的副本仍会占空间**，重负载下一天也能攒出几个 GB。若需要更低占用，调小 `WORKTREE_RETENTION_MS`
  即可（当前与 `MAX_DIR_STORES` 一样是常量，不对外暴露）。
- 回收发生在创建路径上，因此**从不创建新副本的项目其旧副本不会被清**——但那也意味着它不再增长。
- git 侧的长路径失败（Windows 260 字符限制）在 `remove` 里有降级路径，但 `fs.remove` 同样可能失败；
  那种残骸本次未覆盖，只能手工清。
