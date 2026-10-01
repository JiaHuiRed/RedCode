# 会话费用币种回填改以 part 表为权威源（取代 `*_from_messages`）

日期：2026-10-01　｜　状态：implemented　｜　前置：`2026-09-30-session-cost-currency-truth.md`

## 为什么改

第三方审计复核 6261c96 的币种分桶实现，坐实三个问题（均已在本仓工作树复核）：

1. **竞态丢账（P1）**：`session_cost_currency_from_messages` 只扫「两桶皆 NULL」的会话行。回填窗口内 projector 先写过任一桶的会话**永久退出扫描集**——UPDATE 的双 NULL guard 保住了不互相覆盖，但也保住了「这段历史永远没人回填」；`attributed` 还在 guard 未命中时无条件虚增。
2. **历史 part 无币种（P1）**：回填只动 session 行。旧 part 的 `currency` 缺失，revert/负冲抵时 projector 按「无币种 = USD」扣错桶（CNY 账的删除冲进 USD 桶，总账不变、两桶皆错）。
3. **前端 child 聚合丢 legacy（P1/P2）**：子会话旧行（双桶 undefined）按 `?? 0` 贡献零，父总账丢子账；父无桶的 fallback 还把子桶裸加后套父币种，混算。

## 方案

- **权威源换 part 表**：step-finish part 的写入与桶增量在**同一个事务**（`projectors.ts` 的 PartUpdated projector），所以「part 聚合 == 桶投影终态」由事务原子性保证。迁移的聚合与覆盖又同处一个事务，SQLite 串行事务让两者与 projector 写天然互斥——projector 要么全在覆盖前（被聚合看到），要么全在覆盖后（增量叠加），两种交错都不丢账、不加账。
- **覆盖式全量重算**：扫描全部会话（不再依赖桶值做扫描集），桶 = part 聚合、标量 cost = 两桶之和（顺带自愈历史漂移）；`time_updated` 保持原值，回填不算会话活动。
- **part currency 写回**：无币种且 cost≠0 的 step-finish part 按目录 `json_set` 写回，此后 revert 的负冲抵与桶边界一致。分组维度含 `part.currency`：**已有币种的 part 按自身归桶**（与 projector 增量同界，目录后来改了也不改写历史），目录只用于无币种旧 part。
- **迁移改名 `session_cost_currency_from_parts`**：旧完成行会让已跑过旧版的库跳过新逻辑，必须换名强制重跑。
- **前端 child 聚合三通道**（`session-context-summary.ts`）：桶任一存在按桶并入；双缺的旧行进 legacy 通道，不再 `?? 0` 丢账。legacy 按父账本币种并入是过渡期近似——迁移重跑后所有会话行都有桶值（无费用也是 0,0），legacy 通道实际为空，metrics 的 legacy 启发式随之自然退休。

## 备选否决

- **加 attribution 列**（审计建议 B）：能标记归属，但仍需单独处理「projector 已写桶」行的合并逻辑，且多一次 schema migration；part 表聚合方案不需要新列。
- **消息行聚合覆盖**：消息行写入（MessageV2.Event.Updated）与桶增量（PartUpdated）是两个事务，同一笔费用在消息行（快照式总量）与桶增量（事件式 +1）中出现两次，迁移无法区分「这笔的增量已应用没有」——聚合与覆盖窗口内交错会双计或丢账。part 表不存在这个问题。
- **不回填 part、只修前端**：revert 扣错桶依旧，桶与增量边界永远差一截。

## 后果与边界

- 回填按当前 Provider 目录近似历史币种（models.dev + CNY_PRICING + config 并集）；part 已有币种的行不受目录漂移影响。目录查不到且无币种才记 unresolved（cost>0），汇总日志一行计数，不静默。
- 全量重算一次性成本：所有会话 × part join message，分页 100/页 + 10ms sleep；无 part 会话桶归 (0,0)、标量归 0（自愈语义）。
- 已跑过旧迁移的库会再跑一次新迁移（预期行为）。
- 免费分片（cost=0）不写回 currency：±0 无桶差异，减少写放大。

## 回归与验证

- `packages/opencode/test/session/cost-currency-migration.test.ts` 7 条：legacy CNY 归位 + part 盖章、projector 先写交错（不丢旧账）、迁移先写交错（增量正确叠加）、未知模型 USD + unresolved、免费分片不盖章、无 part 会话漂移自愈、双币种不混算。
- `session-context-metrics.test.ts` 22 条不回归；opencode / app typecheck 0。

## 模型可见四问

不进模型上下文（纯服务端数据迁移 + 前端显示层）；固定前缀 0 增量；KV cache 不动；无新增注入项。
