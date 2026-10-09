# GUI 内存无界点钉住（第一批）

## 问题

单会话 GUI renderer 实测 2.4GiB（261009 峰值 5GB），对比 TUI 三会话 ~3GB。两路只读审计（renderer 数据层 / Electron+sidecar）确认四个无界与乘数点：

1. **分页合并路径无上限**：`event-reducer` 的每会话消息上限只在流式插入路径执行；`loadMessages` 的 merge（prepend/refresh/anchor 补拉）完全无封顶——往上翻过深历史的会话把整段已加载历史常驻内存，且当前会话在 session 40-LRU 里被 keep 永不淘汰。
2. **目录乘数 30**：`MAX_DIR_STORES=30` × `SESSION_CACHE_LIMIT=40` × 100~400 条消息+parts；sidecar 侧每目录一整套 InstanceState（`instance-state.ts` capacity 默认 `Infinity`）+ MCP 每目录一整套 stdio server（`mcp/index.ts` 自注实测 10×6=60 进程）。30 是按最坏形态设计的，单项目用户用不满。
3. `instance-dispose` 失败日志打 `[object Object]`，renderer.log 无法排查。
4. 第一批未处理的 `/global/event` 队列已在后续独立改动加双预算与溢出恢复，见 `2026-10-09-global-sse-buffer.md`；`providerCatalog` `gcTime: Infinity` 的实际对象成本仍需量测。

## 决策

- 封顶常量取 `HELD_MESSAGES_PER_SESSION`(400)：与 message-window 持有语义同源，≥ 首拉 200（否则首屏即裁），不引入持有/非持有行为分叉。超出裁最旧 + 标 `message_trimmed`（260904 回拉机制复用，`more()`/`loadMore()` 据此绕过 complete 往回拉）+ 清被裁消息的 parts。`loadMessages` 与快照回退两处合并点统一走 `capMessageWindow`。
- `MAX_DIR_STORES` 与 directory-sync `maxDirs` 30→10 同步降：这是 renderer 会话缓存、sidecar InstanceState、MCP 进程树的三重乘数；多项目来回切 10 个 LRU 也够。
- 不复刻 5GB 现场拍 heap snapshot：本机 16GB 硬上限，复刻即打爆。以结构性诊断 + 定向测试代替；日常状态 snapshot 对照留待后续批次。

## 验证

GUI 定向回归 55 pass / 0 fail（session-changes、reconnect、event-reducer、message-window 含 `capMessageWindow` 3 用例、instance-dispose），typecheck 通过。

## 边界

不解决：V8 长跑堆不归还（需 snapshot 对照活对象 vs 空闲未归还）；sidecar per-dir InstanceState 无上限（capacity 默认 Infinity，缓存类服务待加预算或 LRU）；MCP server 跨目录共享化；事件队列上限。目录上限收紧后，频繁跨 >10 项目切换会付出 LRU 淘汰后重访重建的成本。
