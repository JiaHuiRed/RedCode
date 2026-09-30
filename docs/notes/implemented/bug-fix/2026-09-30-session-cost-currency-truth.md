# 会话费用币种与金额的事实源统一（costByCurrency）

状态:implemented

## 问题

`8434fca` 之后，金额与累计 token 改读服务端 session 行聚合（全量账），但币种仍由前端**已加载消息子集**推：

- `session-context-metrics.ts:91-130` 按 `m.cost > 0` 的消息建 `costByModel` 取贡献最大者定币种，`:129` 无付费消息时兜底 USD
- 于是 `messages = []`（或分页窗口未含付费模型）时，aggregate 里的 CNY 费用按 USD 显示——金额已全量、币种仍错
- 子会话同病：`session-context-summary.ts` 的 `childCost` 是裸数字相加，再套父会话单一币种
- TUI 侧边栏是第三处口径：`cli/cmd/tui/feature-plugins/sidebar/context.tsx` 取**当前模型**的 `cost.currency`，会话中途换过模型即错
- 现有测试只覆盖两种场景，缺「窗口无付费消息」「多币种共存」两条

## 决策

方案 A：币种随金额一起在服务端分桶记账，前端只读桶。

1. `StepFinishPart` 增可选 `currency` 字段（`message-v2.ts`）。processor 写 part 时填（币种与 cost 同时刻定格，语义同 260816 的取价定格）；未声明币种却产生费用的模型按 USD 入桶并 `log.warn("step_finish.missing_currency")`（每模型一次，不静默）。唯一权威是 `model.cost.currency`——`CNY_PRICING` 覆盖与 config 声明都汇在 provider.ts:1529-1548 这一处，峰谷旁路表（tiered-pricing）不带币种。
2. `SessionTable` 增 `cost_cny` / `cost_usd` 两个可空 real 列（NULL = 未归属的旧行）。`applyUsage`（`projectors.ts`）按币种增量只动归属那一桶（`coalesce(...,0)+delta`），`sign = -1` 的 revert 天然覆盖；另一桶保持原值不动，不把旧行的 NULL 提前烫成 0。
   - 取舍：用两列而非 `Record<string, number>`——全仓币种就是 `"USD" | "CNY"` 联合，两列走增量 SQL 零 JSON 解析；真出现第三种币种时加列 + 迁移，代价可接受。
3. 旧行回填 = 新迁移 `session_cost_currency_from_messages`（`data-migration.ts`）：分页扫两桶皆 NULL 的行，按 session × provider × model 聚合消息级 cost（消息级 cost 是该消息所有 step 之和，与 part 级增量等价），目录定桶。迁移依赖 Provider 目录，`defaultLayer` 按本仓惯例自供（`layer.pipe(Layer.provide(Provider.defaultLayer))`，mergeAll 不做兄弟层消解）。
4. 聚合字段经 `Session.Info` / sync 行下发，SDK 与 openapi 按仓库规矩两条命令都重生成。
5. UI 规则：单桶 → 该币种符号；多桶 → `¥69.21 + $0.30`，不做汇率混算；子会话按桶合并后同一套规则（`childBuckets` 按 parentID 累两桶）。TUI `sidebar/context.tsx` 改读聚合桶（`costLabel`），撤掉「当前模型币种」逻辑——三处口径一次收完。
6. 汇率折算本轮不做：provider 账单原币种是事实，统一换算是产品策略，两者不混在记账层；将来要折算必须显式带 `baseCurrency` / `exchangeRate` / `rateTimestamp`，否则历史账随汇率跳动。

## 与原方案的三处偏差（都是落地时的现实约束）

1. **UNKNOWN 桶没有独立成列**。方案里「老消息缺 currency → UNKNOWN 桶显式展示」，落地改成：回填按当前目录近似，目录查不到的模型按 USD 并入桶、按会话计数，迁移结束 `log.info({attributed, unresolved})`。理由：真正 celibataire 的分桶表在 UNKNOWN 上要多一列 + 前端多一种渲染分支，而「查不到」本身已由计数日志显式化。旧行若回填失败/未跑，前端仍走旧启发式（legacyCurrency），不再假装正确。
2. **投影器单测没写**。`applyUsage` 未导出、test/session/ 无现成 DB 级投影器 harness（`recent-tool-parts.test.ts` 是另一种形态），本轮以 metrics 层四场景（含双桶）+ 既有 session 套件 15 条覆盖；真实增量路径的 DB 级回归列为后续。
3. **project 级面板（home-stats / usage.ts）仍是旧口径**：按 `model.cost.currency` 折算。它是项目级汇总、与本次会话级修的是两个展示位，本轮不动；识别签名相同（金额与币种来自不同数据源），下轮同法收。

## 测试

- Case 1：`messages = []` + aggregate 为 CNY → 金额与币种都正确，不 fallback USD（`session-context-metrics.test.ts`）
- Case 2：当前窗口只剩免费模型、聚合桶 CNY → 桶优先于消息窗口启发式（同文件，旧启发式答案仍断言为 USD 以证明它只是兜底）
- Case 3：同一会话同时存在 CNY + USD → 两桶原值保留，和不与总账漂移（`toBeCloseTo`，浮点）
- 旧行兜底：两桶皆 undefined 时才走旧启发式（同文件）

## 后果

聚合行从 scalar 变结构，SDK/openapi 要重生成；GUI + TUI 两处口径必须同一批收口，否则三处漂移复发（此前 `metrics.ts` 与 `sidebar/context.tsx` 已经是两套逻辑）。识别签名：UI 上金额与币种来自不同数据源；或多币种相加后只显示一个符号。
