# F-09 性能基线计划（TUI / GUI 统一量化）

审计来源：`docs/reviews/0.19.1-comprehensive-audit.md` §10（F-09，P2，证据 E3）。

## 目标与纪律

建立 TUI 与 GUI 两端共同的量化基线，**先记录数据再谈优化**。审计明确两条红线：

1. 后端测试通过 ≠ 两端性能良好；性能问题可能分别来自终端渲染、SolidJS 响应式、消息同步、工具结果渲染、Electron IPC、sidecar 恢复、大历史加载、prompt 装配。
2. 没数据之前，不把 GUI 卡顿一律归因于 SolidJS，不靠减少测试或禁用功能伪造性能改善。

E3 = 待现场验收：真实 Windows、Electron、用户本机配置、真实模型长对话与实际运行性能。完整表里的多数指标属于 E3，必须真机跑。

## 指标 × 设施对照

§10.2 表格逐项列出「现成设施 / 缺口 / 测量路径」。

| 指标 | TUI | GUI | 现成设施 | 缺口 |
|---|---|---|---|---|
| 冷启动 | 必测 | 必测 | `bench:startup`（`script/bench-startup.ts`，`--mode cli/server`），隔离 HOME/DB、warmup 排除、报 median；GUI 另有 `[timing] sidecar ready`（`packages/desktop/src/main/index.ts:817`） | `bench:startup` 只覆盖 CLI 与 server 进程，不含 Electron 窗口从双击到首帧 |
| 热启动 | 必测 | 必测 | 同上（`--runs` 多次取样） | GUI 冷/热分界（进程常驻 vs 重开窗口）需定义口径 |
| 首次进入 Chat | 必测 | 必测 | 无 | 两端都要新建计时埋点或从外部打点 |
| 100 / 500 / 1000 条消息打开 | 必测 | 必测 | 预算脚本 `bench:budget`（`script/bench-performance-budget.ts`）用 128 vs 2612 条会话测 `filterCompactedEffect` 耗时与内存增长；批量夹具 pattern 见 `test/session/message-v2.test.ts:2292`（500 条）、`llm-idle-guard.test.ts:253`（1000 条） | `bench:budget` 测生产过滤路径，不是「打开会话到首屏可见」的端到端耗时；GUI 时间线埋点（`message-timeline.tsx:429,610,646`）需手动开诊断录制 |
| 长工具结果展示 | 必测 | 必测 | GUI 诊断类型 `timeline.group-build` / `timeline.merge`（`gui-diagnostics.ts:26-29`） | 需构造长工具结果样本 + 手动录制 |
| 首字响应延迟 | 必测 | 必测 | 无现成 baseline 工具 | 真机 + 真实模型；需记录请求发出到首 token 的时间戳 |
| 内存峰值 | 必测 | 必测 | `bench:budget` 报 JS heap + external/native 增长（隔离 DB） | 只覆盖过滤路径，不含完整 TUI/Electron 进程内存 |
| 长会话连续输入响应 | 必测 | 必测 | GUI 诊断 `renderer.longtask`、`ui.input`、`sse.flush` | 需手动录制 + 长会话样本 |
| Chat / Code 切换 | 必测 | 必测 | GUI 诊断 `ui.session.transition` | 需手动录制 |
| 窗口最小化 / 隐藏 / 恢复 | 不适用 | 必测 | 无 | GUI 专属，全部新建 |
| 输入法组合与撤销 | 按终端验证 | Windows 原生验证 | 无 | GUI 用真实 IME + Electron；TUI 按终端能力验证 |

## 现成设施速查

- 启动基准：`bun run bench:startup -- --mode cli|server [--runs N] [--warmup N]`（`package.json:19`）。默认配置来自 `parseBudgetConfig` 的 `startup` 段；环境变量强制隔离 `REDCODE_TEST_HOME` / `REDCODE_CONFIG_DIR` / `REDCODE_DB` / `REDCODE_PURE` / `REDCODE_DISABLE_MODELS_FETCH`，不碰用户数据。
- 测试套件耗时：`packages/redspace` 的 `bench:test` / `profile:test`，方法与边界见 `perf/test-suite.md`（**注意该文档路径仍写 `packages/opencode`，属 F-10 命名债，待统一改名**）。
- 生产路径预算：`packages/redspace` 的 `bench:budget`，有效摘要与空摘要两组、各 128 与 2612 条会话，先硬断言返回条数与折叠边界，再取 median + 放大比 + 内存增长，超预算非零退出；不读用户库/网络。
- GUI 诊断：`packages/app/src/context/gui-diagnostics.ts`。默认关闭（关闭时 `record()` 只做一次布尔判断），录制由用户显式开启；环形缓冲有 `maxRecords=2000` / `maxBytes=512KiB` 上限；导出含 `durations` 的 min/max/avg/p50/p95。事件时间用 `performance.now()`，字符串经过脱敏与匿名 key，导出前仍需人工预览。
- GUI 埋点位置：`timeline.message-read` / `group-build` / `merge` / `measure` 在 `packages/app/src/pages/session/message-timeline.tsx`（429、610、646 行附近）；`ui.input` / `ui.session.transition` / `sse.flush` / `renderer.longtask` 等类型定义见 `gui-diagnostics.ts:18-34`。
- sidecar 启动：`packages/desktop/src/main/index.ts:817` 的 `[timing] sidecar ready` 日志。

## 测量步骤

### A. 当前源码层可跑（不依赖新 exe）

1. `bun run bench:startup -- --mode cli --runs 5 --warmup 1` 记录 TUI/CLI 冷启动 median。
2. `bun run bench:startup -- --mode server --runs 5 --warmup 1` 记录 server 冷启动 median。
3. `cd packages/redspace && bun run bench:budget` 记录大历史过滤的耗时/放大比/内存。
4. 把 1–3 的数字连同命令、日期、机器配置记入本文件的「基线记录」节。

### B. 需更新 exe 后真机跑（E3）

先在隔离环境编译覆盖 `dist`（当前会话占用 exe，需退出 TUI 后操作），然后：

1. TUI：用真实长会话跑「首次进 Chat / 1000 条消息打开 / 长工具结果 / 连续输入 / Chat-Code 切换」，记录墙钟与主观卡顿。
2. GUI：开启诊断录制 → 同一组操作 → 导出 `redcode.gui-diagnostics/v1` JSON，取各 `durations` 的 p50/p95。
3. GUI 专属：窗口最小化/隐藏/恢复耗时；真实 IME 组合与撤销。
4. 首字延迟：两端各发真实请求，记录请求发出到首个可见 token 的时间。
5. 内存峰值：完整进程（非仅过滤路径）在长会话下的 RSS/heap 峰值。

## 基线记录

### A 组 · 生产路径预算 `bench:budget`（2026-11-18，本机 Windows / Bun 1.3.14）

命令：`cd packages/redspace && bun run bench:budget`（隔离临时 DB，不读用户库/网络）。自检 3/3 通过。

基准分两组，先做条数与边界硬断言，再预热 2 次、测量 5 次取中位数：

- **有效摘要**：摘要助手消息带非空 `text` part，`filterCompactedEffect` 按 `tail_start_id` 折叠历史，两个样本都应返回 72 条（压缩触发 + 摘要 + 保留尾重排）。
- **空摘要**：摘要助手消息没有正文，生产代码保留全部原文（失败保护路径），应返回 128 / 2,612 条。

| METRIC | 2026-11-18（一轮完整输出） | 预算 | 结论 |
|---|---|---|---|
| `filter_compacted_small_median_ms`（128 条，有效摘要，返回 72） | 9.12 | — | 基线 |
| `filter_compacted_large_median_ms`（2612 条，有效摘要，返回 72） | 6.76 | ≤50 | 通过 |
| `filter_compacted_scaling_ratio` | 0.74 | ≤6 | 通过 |
| `filter_compacted_large_memory_growth_bytes` | 459 | ≤16777216 | 通过（≈0.45 KiB） |
| `filter_compacted_empty_small_median_ms`（128 条，空摘要，返回 128） | 7.91 | — | 基线 |
| `filter_compacted_empty_large_median_ms`（2612 条，空摘要，返回 2612） | 135.50 | ≤600 | 通过（只防数量级退化） |
| `filter_compacted_empty_scaling_ratio` | 17.13 | — | 只记录 |
| `filter_compacted_empty_large_memory_growth_bytes` | 3192065 | — | 只记录（≈3.05 MiB） |

多次复测（同日，5 轮）：有效组 large 6.5–9.4 ms、放大比 0.74–1.12；空摘要组 large 130–175 ms、放大比 12–17.5。有效组的两个样本返回条数相同，耗时差异落在噪声内，放大比因此可以小于 1——这说明折叠路径在当前构造下是常数级。

**旧数据口径更正。** 本节此前记录的 59.41 / 63.21 ms 与 11.51 / 12.13 放大比来自空摘要构造（摘要消息没有 `text` part），测的是「保留全部原文」的全量回读路径，不是折叠路径，也不是 `filterCompactedEffect` 的算法回归。同口径当日复测落在 130–175 ms，说明那两次 59–63 ms 属文件缓存与机器负载窗口，不能与固定前缀路径混谈。

**空摘要预算的边界。** 600 ms 是灾难守卫（本机区间的约 4 倍），只用于发现数量级退化，不用于跨机器比较——机器负载、OS 文件缓存和同一进程内前序测量留下的堆状态都会改变这个绝对值。若未来挂入 CI，先按目标机器重定阈值再启用。

**结论：** A 组由「待调查信号」转为「两条路径各有基线」。折叠路径（有效摘要）有可解释的绝对耗时与内存数字，预算有余量；空摘要路径的数字单独记录，不再与折叠路径共用一个条数断言。

### B 组（E3 真机）

尚未采集——等 exe 更新后按上方「B. 需更新 exe 后真机跑」步骤补。

## 相关文件

- 审计：`docs/reviews/0.19.1-comprehensive-audit.md` §10、证据 E3 定义（约 62 行）
- 启动基准：`script/bench-startup.ts`、根 `package.json:19`
- 预算：`script/check-entry-graphs.ts`（`parseBudgetConfig`）、`packages/redspace/script/bench-performance-budget.ts`
- 测试套件：`perf/test-suite.md`、`packages/redspace/script/{bench-test-suite,profile-test-files}.ts`
- GUI：`packages/app/src/context/gui-diagnostics.ts`、`packages/app/src/pages/session/message-timeline.tsx`、`packages/desktop/src/main/index.ts`
