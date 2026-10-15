# GUI 崩溃取证补齐：日志根、window scope、资源快照与事件 2004

状态:implemented

## 问题

261015 的 GUI 崩溃导出包（`redcode-debug-20261015T045158.zip`，RedCode Dev 0.12.10 packaged
win32 x64，Electron 44.2.0）缺了定位所需的关键证据：

- `logging.ts` 的 `serverLogRoots()` 仍在搜 `~/.local/share/redcode/log` 与 desktop userData 下
  的 `redcode/log`，而后端实际写 `~/.redcode/data/log`——ZIP 里**一份后端日志都没有**。
  真实的 MCP `spawn ENOMEM` / `Connection closed` 全在本机 `~/.redcode/data/log/` 里。
- crash report 的 scope 列表只有 main/renderer/server/utility，**没收 window**，而
  unresponsive 的 JS 调用栈采样正写在 window.log。
- renderer unresponsive / process gone 时不记录任何资源上下文，而系统日志里
  Resource-Exhaustion-Detector 有两条 Event 2004（12:41:05、12:48:32）：后者
  SystemCommitCharge 43,912,642,560 / limit 43,936,808,960，仅剩 23.05 MiB，物理内存
  16,471,826,432 / 17,093,005,312，502 个进程。
- 导出收集静默跳过超过 24h、超过 50MiB 的文件，manifest 不记原因；附件名可能碰撞；
  单文件/整包没有硬上限。

崩溃本身的源码级诱因**仍未证实**：内存耗尽是强上下文证据，不等于某段代码的根因；无 dump 不能
反推"从未生成"，无 JS 栈采样不能排除 JS 死循环（采样 await 可能未返回）。

## 决策

- **后端日志根**改用与 core 相同的路径协议（`REDCODE_TEST_HOME ?? homedir()` + `.redcode/data/log`），
  保留两条 legacy 根兜底；不跨 rootDir import 带初始化副作用的核心模块，路径规则在此复刻一句并注释。
- **crash report scope 加入 window.log**。
- **轻量资源快照**：unresponsive / process-gone 时用 `app.getAppMetrics()` + `os.freemem/totalmem()`
  写一条 window scope 记录；`workingSetSize`/`privateBytes` 按 Electron 文档口径从 KB 转字节；
  明确标注"物理内存 ≠ 系统 commit 配额"。**不恢复常驻全机进程扫描**（260901 退役
  `REDCODE_METRICS=1` 的原因：每 15 秒一次 565–697ms 的 CIM 全进程查询，一天 5760 次，
  触发 Defender 扫描）——只在事发时刻采一次。
- **Event 2004 按需采集**：仅导出时执行一次，run 开始前 24h 到导出时刻，≤20 条、32KiB、
  4 秒超时的异步 `execFile`（显式 UTF8）；无匹配返回空数组，查询失败/超时/超限只记 manifest
  状态，不阻塞导出。本会话已实证该 provider 无需提权可读。
- **manifest 记账**：每个来源记录 `included` 与 `skipped`（outside-time-window / over-size-limit /
  sensitive-heapsnapshot-excluded / symbolic-link-excluded / export-budget-exceeded /
  unreadable:CODE / archive-add-failed:CODE 等），外加整体预算用量。
- **硬预算**：整包 1000 文件 / 100MiB，单文件 50MiB，扫描 4000 条目，目录深度 64；
  符号链接不跟随；`.heapsnapshot` 不收（可能带 secret）；归档名净化 + 去重；
  单个文件读取失败只记跳过，不让整个导出失败。

## 备选与否决理由

- **恢复常驻周期性系统监控**：否决——旧 metrics 的性能/Defender 代价已实证，改成事发快照。
- **把物理内存当 commit 消耗上报**：否决——两者是不同的量，快照里显式标注，避免下次误读。
- **收 heapsnapshot 进包**：否决——可能含 secret，导出包会被随手分享。
- **跟随符号链接**：否决——会逃出日志根、可能成环，改为 lstat 跳过并记账。
- **预算做成可配置项**：否决——这是诊断安全边界（防 32MB 单行/无限条目撑爆导出），
  按本仓"协议常量与安全不变量钉死"的例外处理为常量。

## 后果

- 导出多一次最多 4 秒的 Windows 子进程（仅点导出时）；快照是同步 Electron/OS API，无子进程。
- ZIP 仍可能没有原生 dump——Crashpad 没生成就是没有；缺失本身要在 manifest 与 note 里被读作
  "未采集到"，不能读作"不存在"。
- 崩溃根因未定位：本次只补取证，不做自动 reload/respawn（`windows.ts` 现有行为不变）。
- 定向测试 11 项覆盖：日志根优先级、window scope、时间窗/体积/heapsnapshot/符号链接/深度与
  扫描上限、预算边界、KB→字节换算与物理内存标注、条目消失记账、Event 2004 的边界
  （时间窗、UTF8、spawn options、空结果、超限、坏 JSON、超时、非 Windows）。
