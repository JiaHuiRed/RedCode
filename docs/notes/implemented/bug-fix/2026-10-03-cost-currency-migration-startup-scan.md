# 费用币种迁移按 part 的消息主键盖章，避免启动期反复扫描全库

状态：implemented

## 问题

`8b60007e` 将费用回填改为 part 权威源后，旧 part 的 currency 写回按费用分组执行。其 `message_id IN (SELECT id FROM message WHERE json_extract(data, '$.providerID') = ... AND json_extract(data, '$.modelID') = ...)` 子查询未约束当前 part 或会话，每组都扫描整张 message 表。

2026-10-03 的真实数据库一致性副本约 2.7GB。相同编译版 TUI、配置及凭据，空数据库能进入首页；使用该副本时选工作区后持续黑屏。在副本中仅将 `session_cost_currency_from_parts` 标为完成，首页恢复。真实 helper 首批 100 个会话的可回滚事务超过 30 秒仍未完成，查询计划包含 `SCAN message`；单独的首批聚合查询仅约 228ms，慢点在反复写回子查询。

## 决策

保留全量重算、每批 100 个会话、聚合与覆盖同事务、part 既有币种优先及原迁移名。仅把旧 part 写回改为关联 `EXISTS`，用 `message.id = part.message_id` 定位所属消息，再核对 provider/model。

查询计划以消息主键索引查找代替全表扫描。不新增 schema/index，不伪造真实数据库的迁移完成标记；未完成迁移在修复后的下一次启动正常重试。

## 备选与否决理由

- 跳过迁移或给真实数据库补完成标记：会留下旧费用和 revert 币种缺陷，仅在副本中用于因果对照。
- 增加 JSON 表达式索引：需 schema migration 且只掩盖无界扫描，本来已知当前 part 的 message_id。
- 只延迟迁移启动：让首屏先出现，但后台仍逐组全表扫描并持有写事务，不能解决根因。

## 验证

- 同一副本、首批 100 会话、相同可回滚事务：修改前 >30s（硬截止），修改后 678ms。
- 回归读取 Drizzle 实际执行的 UPDATE SQL，再执行 `EXPLAIN QUERY PLAN`：原实现因 `SCAN message` 红测，修复后主键查找通过。
- `bun test --timeout 30000 ./test/session/cost-currency-migration.test.ts`：8 pass；原有竞态、混币种、免费分片、未知模型、无 part 语义保持。
- `packages/opencode` 的 `bun run typecheck`：通过。

## 后果与边界

单批仍是同步事务，聚合与覆盖的原子性保持；此修复不把迁移改为异步 SQL，也不保证任意历史数据的恒定耗时。GUI 当前已由用户确认恢复，既有 GUI 会话未重启；现有后端健康请求响应 HTTP 401（认证门控仍响应），不把它当成 GUI 全流程测试。

## 模型可见四问

本次只改数据迁移 SQL 与回归，不新增或移动模型输入；固定前缀 token 变化 0，KV cache 不变，无新增注入项。

## 运行时验证与回退

- 按日常 `packages/opencode/build.bat` 相同的 `--skip-embed-web-ui` 编译参数生成 0.11.17 修复版，先验证 exe，再以备份+复制替换日常 shim 指向的 TUI 程序。没有打包 release、推送或修改配置。
- 真实数据库副本：迁移待执行时约 13.2s 进入主页，676 个会话约 18s 回填完成。
- 真实 live 配置、凭据及原库：约 4.0s 进入主页，676 个会话回填正常完成，完成标记已核对；没有发送模型消息。
- 迁移前原库一致性备份和旧 exe 保留在 `.redcode/temp/tui-startup-20261003-I9QNDG/build/`（`redcode-data-before-repair.db`、`redcode-before-repair.exe`）。不把测试用的伪造完成标记带回原库。
- 第二次真实启动的 ConPTY 关闭探针没有返回，已按已核验 parent PID 清理测试进程树；此前已验证的首屏和迁移完成结果不受影响，不报告第二次启动耗时。
