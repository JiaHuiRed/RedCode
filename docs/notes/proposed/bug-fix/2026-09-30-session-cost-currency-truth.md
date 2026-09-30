# 会话费用币种与金额的事实源统一（costByCurrency）

状态:proposed

## 问题

`8434fca` 之后，金额与累计 token 改读服务端 session 行聚合（全量账），但币种仍由前端**已加载消息子集**推：

- `session-context-metrics.ts:91-130` 按 `m.cost > 0` 的消息建 `costByModel` 取贡献最大者定币种，`:129` 无付费消息时兜底 USD
- 于是 `messages = []`（或分页窗口未含付费模型）时，aggregate 里的 CNY 费用按 USD 显示——金额已全量、币种仍错
- 子会话同病：`session-context-summary.ts:131-139` 的 `childCost` 是裸数字相加，再套父会话单一币种
- TUI 侧边栏是第三处口径：`cli/cmd/tui/feature-plugins/sidebar/context.tsx:203` 取**当前模型**的 `cost.currency`，会话中途换过模型即错
- 现有测试只覆盖两种场景（`session-context-metrics.test.ts:135/162`：免费模型垫底、aggregate 覆盖子集），缺「窗口无付费消息」「多币种共存」两条

## 决策

方案 A（推荐）：币种随金额一起在服务端分桶记账，前端只读桶。

1. `StepFinishPart` 增可选 `currency` 字段（`message-v2.ts:261-283`）。processor 写 part 时填（`processor.ts:773`，provider 侧已有 per-model 计价：`provider.ts:1356`）。老消息缺该字段 → UNKNOWN 桶，不按 USD 静默处理。
2. `SessionTable` 增 `cost_cny` / `cost_usd` 两个 real 列（`session.sql.ts:36` 旁）。`applyUsage`（`projectors.ts:32-45`）按币种增量加减，`sign = -1` 的 revert 路径天然覆盖两桶；`data-migration.ts:85` 的 row→Info 映射同步补。
   - 取舍：用两列而非 `Record<string, number>`——全仓币种就是 `"USD" | "CNY"` 联合（如 `metrics.ts:56`），两列走增量 SQL 零 JSON 解析；真出现第三种币种时加列 + 迁移，代价可接受。
3. 聚合字段经 `SessionAggregate` / sync 行下发（`session-context-metrics.ts:64-67`），SDK 与 openapi 按仓库规矩两条命令都重生成。
4. UI 规则：单桶 → 该币种符号；多桶 → `¥69.21 + $0.30`，不做汇率混算；UNKNOWN 桶非空 → 显式展示且不带符号并记日志，不静默按 USD。子会话按桶合并后同一套规则。TUI `sidebar/context.tsx:203` 改读聚合，撤掉「当前模型币种」逻辑——三处口径一次收完。
5. 汇率折算本轮不做：provider 账单原币种是事实，统一换算是产品策略，两者不混在记账层；将来要折算必须显式带 `baseCurrency` / `exchangeRate` / `rateTimestamp`，否则历史账随汇率跳动。

方案 B（退让项，不建议）：只加 `cost_currency` 单列记主导币种，UI 照旧。修「错符号」主症状便宜一半，但多币种会话的金额仍是裸相加的一个数，且 B 落地后 A 的桶列仍要加，属于把成本分两遍付。

## 测试

- Case 1：`messages = []` + aggregate 为 CNY → 金额与币种都正确，不 fallback USD
- Case 2：当前窗口只剩免费 USD-default 模型、历史付费模型是 CNY → 不 fallback USD
- Case 3：同一会话同时存在 CNY + USD → 不裸相加后冒充单币种，按桶分别展示
- 投影器单测：`applyUsage` 带币种增删（`sign = ±1`）后两桶数值正确、revert 后归零

## 后果

聚合行从 scalar 变结构，SDK/openapi 要重生成；GUI + TUI 两处口径必须同一批收口，否则三处漂移复发（此前 `metrics.ts` 与 `sidebar/context.tsx` 已经是两套逻辑）。识别签名：UI 上金额与币种来自不同数据源；或多币种相加后只显示一个符号。
