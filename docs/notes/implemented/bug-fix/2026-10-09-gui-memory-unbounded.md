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

## 连续窗口增补

400 条 cap 按分页方向裁边：older prepend 保留最旧边并裁最新边，newer append 保留最新边并裁最旧边；两种裁边都逐条清掉对应 parts 和 delta。固定窗口的历史推进信号取边界变化，而不是数组长度；`loadThrough` 仍保留 200 页安全上限。新的 `after` 页面按 `(time.created,id)` 复合序取紧邻页，`before`/`after` 互斥，不改 schema/migration。

裁掉尾部后用 newer-gap 标记约束重连快照与 live stream：快照只同步会话元数据、不会把远端最新页拼进旧窗口；实时更新和 part 事件只进入当前窗口已有消息。用户滚到底按边界连续补 newer，跳到底明确取最新页后再滚动。既有 `session_change` 短期补拉保留，不开启完整 event 表或载荷双写，见 `2026-10-09-session-change-catchup.md`。

验证在主仓（依赖齐全）完成，隔离子代理草稿的「依赖缺失无法验证」结论不适用：GUI 定向四文件 57 pass / 0 fail（message-window、event-reducer、session-changes、session-history-loader，浏览器态 Solid 运行时），core `session-messages` HTTP 契约 8 tests / 64 expects（1000 条复合序夹逼、raw ID 锚点、双向游标、互斥校验），两包 typecheck 通过；SDK/OpenAPI 走官方两条命令重生成，产物与草稿手动版本无差异。隔离环境真实浏览器 1000 条冒烟：轮次栏跳到第 1 条（13 页复合序回拉，store 与 DOM 一致）、缺口期实时消息不进窗且视口不动、回最新后窗口滑到 [602..1001]、`newer` 归零、无孤儿 parts。无内存压力复现，不宣称解释现场 5GB。

草稿集成时修掉四处浏览器态才暴露的问题：① replace 清理名单在 Solid `reconcile` 之后从活数组派生，已替换的 ID 找不到，80 个 parts 成孤儿——清理名单冻结在 reconcile 之前；② 空过滤数组不再跳过写入，权威清空替代保留旧值；③ `stagedHistory.token` 用 `{}` 进 store 会被代理，`finally` 的身份比对永远失配、冻结投影永不释放（browser 态单测红）——换 `Symbol`；④ `loadMore` 的 trimmed 清标记在并发 join 到更新页时会误清（方向盲），改由 prepend 任务内部按「最旧边界推进或 complete」自行清，`loadLatest` 显式等待在途页再取最新。另补齐 event-reducer shift 路径漏掉的 `part_text_accum_delta` 清理，与其余裁边路径对齐。

## 边界

不解决：V8 长跑堆不归还（需 snapshot 对照活对象 vs 空闲未归还）；sidecar per-dir InstanceState 无上限（capacity 默认 Infinity，缓存类服务待加预算或 LRU）；MCP server 跨目录共享化；事件队列上限。目录上限收紧后，频繁跨 >10 项目切换会付出 LRU 淘汰后重访重建的成本。
