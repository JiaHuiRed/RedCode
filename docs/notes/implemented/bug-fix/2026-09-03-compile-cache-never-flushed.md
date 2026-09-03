# V8 编译缓存改成显式 flush——它此前从未落盘

状态：implemented

## 问题

[0.10.0] 记了一条「服务端 bundle 开 V8 编译缓存——import 那 1.3 秒省掉约 260ms」
（`47f37198`）。**这条一直没有生效。**

2026-09-03 性能体检的取证（打包版 0.10.x，15 次启动）：

| 证据 | 值 |
|---|---|
| `compile-cache/v24.16.0-x64-<hash>/` 目录 | 09-01 建出来，此后 **0 个文件** |
| `[sidecar-timing] import virtual:redcode-server` p50 | **1227ms** |
| 同口径 0.9.x（启用缓存之前） | 1222ms |
| 48 次退出中 `code 1 / reason: 'killed'` | **34 次** |

也就是说 import 耗时一毫秒没省，而缓存目录是空的——目录被创建只说明
`enableCompileCache()` 返回了 ENABLED，不说明有任何东西写进去。

根因：**Node 只在退出路径持久化编译缓存。** 而 sidecar 是 Electron 的
utilityProcess，`main/index.ts` 的 `before-quit` 里是 `void killSidecar()`，
既不 `preventDefault` 也不 await——主进程先退出，Electron 直接 TerminateProcess
掉 utility 进程，那个退出路径永远不会跑到。

0.10.0 当时的冷热对照（1245ms → 1035ms）本身没错，但那是在一个**独立的 Node 进程**
里做的，它跑完自然退出，所以缓存写出来了。这是典型的「实验环境比生产多了一个条件」。

## 决策

`sidecar.ts` 增加 `flushCompileCache()`，在 `Server.listen` 成功、
`postMessage({type:"ready"})` 之后 2 秒由一个 `unref` 的定时器调用一次，
与退出路径彻底解耦。

排在 ready 之后而不是 import 之后，是因为主进程收到 ready 就立刻发健康检查
（`5568bce2` 把 ready→healthy 压到 16ms，不能在这里还回去）；unref 保证这个
定时器自己不参与进程存活判定。

同版本 Node（v24.16.0，与 Electron 42.4.1 内置一致）上用 2.36MB 的合成 ESM 模块验过机制：

| 阶段 | 结果 |
|---|---|
| `enableCompileCache` 之后 | 子目录 1、文件 **0** |
| import 之后（未 flush） | 文件 **0** |
| 空转 1.5s（未 flush） | 文件 **0** |
| `flushCompileCache()` | **3ms**，文件 1、2.44MB |
| 下次进程 import（热） | 103ms → **26–28ms** |
| 热态再 flush | 0ms（无新增即无操作） |

真实 bundle 的收益会小于这个合成模块的 4 倍——它 1.3 秒里大部分是模块**执行**
不是编译，编译缓存只能吃掉编译那部分，0.10.0 量到的量级是约 260ms。

## 备选与否决理由

- **import 之后立刻同步 flush**：否决——健康检查那一跳就在紧后面，宁可晚 2 秒也不
  把 `ready→healthy` 的 16ms 还回去。（合成模块上 flush 只要 3ms，真实 bundle 估计
  几十毫秒，但这是白省的，没必要冒险。）
- **改 `before-quit` 为 `preventDefault` + await `killSidecar()`**：否决为本条的解法
  ——它依赖「退出流程一定跑完」这个前提，而崩溃、任务管理器结束进程、系统关机都绕过它。
  显式 flush 不依赖任何退出路径。**但这个改动本身仍然值得单独做**：sidecar 的
  `listener.stop()`（DB 句柄、MCP 子进程）现在同样没有机会跑，那是另一笔账。
- **把 bundle 拆小**：否决——收益不确定且改构建链，成本远大于一行 flush。

## 后果

- 冷缓存那次多付一次 flush（合成模块 3ms；真实 bundle 未单测，量级几十毫秒），
  且发生在 ready 之后，用户感知不到。
- **识别签名**：如果 `compile-cache/<node版本>-<hash>/` 目录里还是 0 个文件，
  说明这条又坏了——验收标准是**目录里出现文件**，不是看日志里有没有调用。
  `[sidecar-timing] flushCompileCache: Nms` 这行会打进 `server.log`。
- 端到端验证需要一次真实的打包版启动：连开三次，看 `[timing] sidecar ready` 的中位数
  是否从 1551ms 下移，以及缓存目录是否非空。本次改动只在同版本 Node 上验了机制。
- 升级 Electron 或重建 bundle 会让缓存目录名变化而自然失效，不需要手工清。

相关：`docs/notes/` 无前身；CHANGELOG [0.10.0] 那条「省掉约 260ms」应视为**当时未兑现**，
本次之后才开始真的兑现。
