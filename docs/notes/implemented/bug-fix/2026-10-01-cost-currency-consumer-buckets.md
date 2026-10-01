# 币种费用桶统一到消费端（stats / run / share / ACP）

日期：2026-10-01 · 执行：YuQi · 审计来源：第三方审计 P2（costByCurrency 迁移与全仓口径）

## 为什么

会话行的 `cost_cny` / `cost_usd` 桶（2026-10-01 part 表重算迁移）落地后，四个旧 USD 展示面仍在把标量 `cost` 当单一币种渲染。审计反例：69.21 CNY + 0.30 USD 裸加成 69.51 "USD" 展示。桶与消费端口径不一致，混合币种用户看到的总数是错的。

## 数据路径澄清（本轮关键发现）

**币种只存在于 step-finish part 上**（`message-v2.ts` StepFinishPart.currency），assistant message info 只有 `cost` 标量。初版实现误引 `info.currency`，typecheck 抓出（SDK 类型无此字段，openapi 生成物与 HEAD 一致——不是生成落后）。三个消费点全部改走 parts 权威路径，与投影器、迁移同界（undefined → USD）。

## 方案

新增共享原语 `packages/opencode/src/session/cost-bucket.ts`（纯函数、零依赖，web 可安全复用语义）：

- `CostBucket { cny, usd }` + `addCost(bucket, currency|undefined, amount)`（undefined→USD 同界）
- `formatCost(bucket)`：单币种单行，混合并排 `" + "` 连接，**绝不求和**
- `singleCurrencyAmount(bucket)`：恰一非零币种才退化成 `{amount, currency}`，否则 undefined——给单币种协议做诚实降级

消费端：

| 消费面 | 改动 |
| --- | --- |
| CLI stats | 会话级按 `session.costCny/costUsd` 桶；模型级从 message.parts 的 step-finish 按 part.currency 归桶；Total/Avg/per-model 全走 `formatCost` |
| CLI run footer | `SessionData.finishCurrency: Map<messageID, currency>`，`message.part.updated` 的 step-finish 记录，`message.updated` 的 formatUsage 按它选 Intl 货币（缺省 USD） |
| Web share | `data()` 桶化（msg.parts 的 step-finish），`formatCostParts` 本地实现（web 不运行时 import opencode 源码，注释对齐语义），混合并排展示 |
| ACP usage_update | 从 assistantMessages 的 parts step-finish 归桶；`singleCurrencyAmount` 拿到单币种才发 `cost`，混合/全零**省略字段**（协议 `cost?: Cost | null` 可选）——宁可不给也不伪装 |

## 否决的备选

- 消息级 `info.currency`：字段不存在（schema 即无），非生成物问题。
- 混合币种按主币种折算：引入汇率假设，比谎报更隐蔽。
- ACP 混合时发 0：客户端会显示 $0.00，误读为免费。
- Web 运行时 import `redcode/session/cost-bucket.ts`：web 的 `redcode/*` 解析路径未验证运行时行为，只做 type import；本地保持同界实现。

## 边界与遗留

- stats 的 `totalCost` 标量保留（兼容既有字段），展示不再用它；迁移窗口中段 legacy 行（双桶 NULL）不进币种桶，Total 桶显示会短暂低估——迁移强制重跑后消失。
- **web 包无 typecheck 工具链**（无脚本，`astro check` 在本环境 tsconfig 解析崩溃，非本次改动引入）。Share.tsx / common.tsx 未过类型检查，narrow 正确性人工核对（`part.type === "step-finish"` 是 schema tag 判断，旧数据 currency undefined 落 USD 分支）。
- `formatCost` 的 CNY 符号在 en-US 下是 `CN¥`（Intl 行为），测试断言按实际输出。

## 验证

- `bun test ./test/session/cost-bucket.test.ts` 13 pass（含审计反例断言：混合 ≠ 总和）。
- `bun test ./test/cli/run/session-data.test.ts` 18 pass（新增 2 条：step-finish CNY → `CN¥1.50`；无 step-finish → `$1.50`）。
- `bun run typecheck`（packages/opencode）exit 0。
- prettier --write 格式化 stats.ts / cost-bucket.ts，其余 unchanged。

## 模型可见四问

模型可见输入零变化：本改动全部是 CLI 展示、GUI share 页、ACP 协议输出，不进提示词、不进注入面、无固定前缀影响、无 KV cache 影响。
