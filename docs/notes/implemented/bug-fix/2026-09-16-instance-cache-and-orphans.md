# 服务端实例缓存加上限，孤儿 MCP 进程下次启动清扫

状态: implemented

## 问题

GUI 开 5G 内存、任务管理器里 150 个 RedCode 相关进程：主 GUI 一个实例下挂着 sidecar（764MB）加 **60 个 MCP 子进程**（6 种 server × 10 个目录），另有 **40 个孤儿进程**（父进程早已不在）。

两个根因，方向相反：

1. **常驻堆积**：客户端目录缓存有上限（`MAX_DIR_STORES = 30`、空闲 20 分钟淘汰），服务端 `InstanceState` 的 `ScopedCache` 却是 `capacity: Number.POSITIVE_INFINITY`。30 个以内客户端永不淘汰 → 永不调 `/instance/dispose` → 服务端的回收器（`instance-registry.ts` 的 `disposeInstance`，唯一入口）永远不触发。碰过的每个目录都永久留一整套 MCP 进程树。
2. **退出残留**：sidecar 拉起的 MCP 子进程在 Windows 上没有 job object 兜底（那套绑定是 `bun:ffi`，GUI 的 sidecar 是 node bundle，用不了），父进程一死就成孤儿。两条路：① **sidecar 猝死重生时**旧的一树没人清（`handleSidecarExit` 直接把旧 PID 丢掉了）；② main 被强杀或崩溃时，`exit`/`SIGINT`/`SIGTERM`/`before-quit`/`will-quit` 一条都跑不到。

## 决策

**常驻堆积**：`InstanceState.make(init, capacity = Number.POSITIVE_INFINITY)` 加可选上限（默认不变，26 个调用点里只有需要改动的显式传参），先给四个会拉子进程树的服务各传 `10`：MCP、文件 watcher、LSP、PTY。超出容量按最久未用淘汰，淘汰会跑各服务自己的 finalizer（关子进程），下次进入该目录再重建。

**退出残留**：新增 `packages/desktop/src/main/sidecar-registry.ts`，把「谁在带这棵树」落盘到 `~/.redcode/data/sidecar-tree.json`，在两个时机按 `ParentProcessId` 反查清孩子：

- **sidecar 猝死、重生之前**（`handleSidecarExit`）：趁还知道旧 PID，`killOrphanChildren(旧 PID)` 清掉它的孩子，再 respawn。
- **下次启动、拉起新 sidecar 之前**（`sweepStaleSidecarTree`）：处理「上次崩溃/被强杀」留下的残骸。先看记录里的 `appPid` 是否还活着（活着＝另一个实例在用，不动），再看旧 sidecar 还在不在：还在且命令行认得出是我们的才杀整树，已经不在就按 `ParentProcessId` 反查孩子杀。杀完删记录。

`taskkill /T` 对已退出的父进程无效，所以必须是「反查孩子再各自 `taskkill /T`」，不能只杀父。

## 备选与否决理由

- **给 `ScopedCache` 加全局 `timeToLive`，不用 capacity**：Effect 的 TTL 语义偏绝对存活时长，正在使用中的实例也会被计时——用一个正在干活的目录去换超时，误杀风险高于 LRU。
- **26 个调用点全加上限**：`bus`、`env` 这类轻量状态服务淘汰重建有副作用（订阅丢失、状态重置），它们不持有子进程，加上限是纯风险。
- **让 node 运行时也走 Windows Job Object**：绑定依赖 `bun:ffi`，node bundle 用不了；`windows-job.ts` 里指向 `windows-job-runner.js` 的那个分支是个死分支（该文件在源码与构建脚本里都不存在）。要做得引入原生依赖，代价高于收益。
- **在 main 退出时清理孤儿**：崩溃/强杀的进程已经不存在，任何退出钩子都跑不到，只能在下次启动补。PID 复用靠「命令行认得出是 sidecar」判断，认不出就不动（宁可漏清一次，不可误杀）。

## 后果

- 服务端每个进程最多保留 10 个目录的实例；MCP/watcher/LSP/PTY 四个服务的常驻上限从此有界。
- 孤儿在下次启动时被清（本次会话内的孤儿由重生前那次清理负责），用户从任务管理器里应该看不到成排的 python/node/fff-mcp。
- 未覆盖：main 崩溃后到下次启动之间，残骸仍然活着——这段窗口里没有任何代码在跑。要彻底消除得靠原生 job object，仍待评估。
- 手动验证边界：未做实机验收（当时 GUI 未运行且包规则禁止重启），只过了 `bun run typecheck`。
