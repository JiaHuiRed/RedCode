# windows-job runner 短路提前到模块加载之前（消除每个 MCP 宿主 178MB 冗余）

状态:implemented

## 问题

2026-09-11 隔壁 TUI（编译 exe，0.11.3）「啥也没干突然崩溃」，报 `Error: Failed to create TextBuffer`。

**这不是 opentui 的缺陷，是原生内存分配失败（OOM）**。证据链：

1. opentui 原生绑定 `@opentui/core/chunk-bun-xmsp0nqq.js:16388-16394` 的 `createTextBuffer(widthMethod)` 不接受尺寸参数（创建空 buffer，后续 append 才增长），返回空指针后唯一合理解释是底层 malloc 失败并 throw。
2. 同机同期独立证据：同日跑测试时得到 `Failed to create renderer: error.OutOfMemory`。
3. 内存账（实测，同一时刻）：

| 进程 | 数量 | 每个 | 小计 |
|---|---|---|---|
| `redcode.exe --windows-job-runner`（MCP 宿主） | 9 | 218-219MB | ~2.0GB |
| `redcode.exe`（主 TUI） | 1 | 831MB | 0.8GB |

机器 16GB，且用户会同时开多个 TUI 实例——叠加第二个实例即触顶。

**根因**：`packages/opencode/src/index.ts` 旧结构是 L1-44 四十多个静态 import，**L46 才做 runner 短路**：

```ts
import { RunCommand } from "./cli/cmd/run"      // 静态 import 全部先求值
import { Database } from "@/storage/db"
...
if (process.env.REDCODE_WINDOWS_JOB_RUNNER === "1") {   // 第 46 行
  await import("./util/windows-job-runner")
  process.exit()
}
```

ESM 的静态 import 在模块体执行前全部求值，所以第 46 行的「提前退出」什么也没省下。一个只需 `bun:ffi` + `node:fs` 的 job-object 包装进程（`util/windows-job-runner.ts`，331 行）背上了整套 TUI/server/session/DB 模块图。

触发面：每个 MCP 服务器经 `util/windows-job.ts` 包一层 runner（为了 job object `KILL_ON_JOB_CLOSE`，让 MCP 随主进程退出）。编译 exe 下 `runnerInvocation()` 返回 `[process.execPath]`（exe 自己），因此走的就是 index.ts；**源码模式（bun dev）下 runner 直接跑 `windows-job-runner.ts`，不走 index.ts——该缺陷只存在于编译产物，验证必须编译。**

## 决策

`src/index.ts` 的 runner 短路移到文件最前（任何重模块之前），四十多个 import 改为**按原顺序**的 top-level `await import()` 解构：

- 保留静态：`node:os` 的 `EOL`、`node:path` 的 `path`（node 内建，零模块图成本）、以及 `import type { Level as LogLevel }`（`Log.Level` 只在类型位置使用；type import 编译期擦除）。
- 其余全部 `const { X } = await import("...")`；`import * as Log` 对应 `const Log = await import(...)`；`yargs` 默认导出取 `.default`。
- 顺序 await（不用 `Promise.all`）以严格保持原有求值顺序。

实测收益（同一脚本对两个 exe 各起一个 `--windows-job-runner` 进程采样工作集）：

| exe | runner 工作集 |
|---|---|
| 旧（静态 import） | **229.2MB** |
| 新（动态 import） | **51.5MB** |

每个 runner 省 177.7MB（-78%）；9 个 MCP 宿主合计约 **1.6GB**。

## 备选与否决理由

- **runner 独立编译成第二个 exe**：否决——RedCode 的交付形态是单文件 exe，`bun build --compile` 单入口，为 runner 多发一个二进制改变分发与升级路径，代价远大于收益。
- **多个 MCP 共用一个 runner 宿主**：否决——runner 与 job object 一一对应（`KILL_ON_JOB_CLOSE` 的隔离语义），合并会把「每个 MCP 一个 job」改成「全部 MCP 一个 job」，生命周期粒度变粗，属架构级改动。
- **只把最重的几个模块改动态**：否决——`cli/cmd/*` 会传递引入 server/session/storage，无法穷尽，「重」的边界会随代码演化漂移，收益也不完整。
- **`Promise.all` 并发加载**：否决——会改变模块求值顺序，模块级副作用（如 `Log` 初始化相关）顺序敏感，风险不对称。
- **保持现状、只建议用户少开 TUI**：否决——缺陷在自身启动路径，能修就该修；且用户的机器（16GB）正是会被这一项压垮的配置。

## 后果

- **主路径**：四十多次顺序 `await import()` 替代静态内联。实测编译 2.5s、`--version` smoke test 正常返回 `0.11.4`、runner 端到端（ready → start → exit code=0）复验通过。
- **防回归识别签名**：`--windows-job-runner` 进程工作集 **>100MB 即为回归**（新基线 ~52MB，旧值 229MB）。任何在 runner 短路之前重新引入静态重 import 的改动都会立刻表现为此。
- **配套**：`script/build.ts` 固定输出 `dist/redcode-windows-x64/bin/`，编译前 `rm -rf dist`——**验证编译产物时不要直接跑 build，会删/覆盖正在运行的 exe**；用 `.redcode/temp/` 下的临时 outfile 脚本（本次验证用完即删）。
- **运维含义**：旧版每个 TUI 实例的 MCP 宿主持有 ~2GB，是 16GB 机器上「多开 TUI 即崩」的直接原因；升级到本版后同一场景的常驻占用下降约 1.6GB。
