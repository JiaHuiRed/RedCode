# 跨模型推理剥离：换模型回放不再降级成 text

- 日期：2026-10-24
- 状态：已实施（`packages/opencode/src/session/message-v2.ts`）
- 背景：ZCode（智谱官方 harness）源码学习批。其 `reasoning-history-normalization.ts` 的
  五步回放归一化里，`removeCrossModelReasoning`（跨模型推理整段丢弃）是唯一在 RedCode
  没有等价物的普适项——本次吸收。同批审计确认的其余机制 RedCode 均已有对应实现
  （见文末对照），未重复建设。

## 问题

`toUIMessages` 对「另一模型产出的 assistant」的推理部分做**降级**：`reasoning` part →
`text` part 原文保留（上游 opencode 继承行为，无决策注释）。后果：

1. **token 膨胀**：推理重的会话一切模型，历史里的全部思考散文（实测本机一会长会话
   572 个 reasoning part）以正文形态灌给新模型，量级可达几十 K token。
2. **语义污染**：新模型把旧模型的过程性思考当最终输出读——思考里常见自我否定、
   被否决的方案，混进正文比删掉更危险。
3. **无缓存代价**：切模型本来就换前缀桶（`modelKey` 分桶），剥离不损失任何已有缓存。

## 决策

跨模型（`differentModel`）的 `reasoning` part **整段剥离**（`continue`），对齐 ZCode
`removeCrossModelReasoning` 与 Claude Code 的同类行为。结论性内容无需保留：text part
里已有最终答案，工具调用链完整。

剥离可能把「纯思考轮」assistant 剥到只剩 step-start——`convertToModelMessages` 会把
只剩 step-start 的消息整条滤掉，造成相邻 user 消息（anthropic 协议要求交替，拒收）。
因此剥空时补占位符 `[Thinking removed]`（对齐 ZCode 的 `REJECTED_REASONING_FALLBACK`
与 `repairEmptyAssistantContent`），消息条数与角色交替和降级版逐条一致。

## 备选与否决

- **维持降级（现状）**：否决，理由见问题 1/2。
- **降级 + 截断**（如保留前 200 字）：多一套参数、省一半不到，且截断的思考比没有更
  误导；ZCode 也没有这么做。
- **配置开关逃生**：不加。行为单向变优（更少 token、更少污染），无场景需要旧行为；
  真要回退 git revert 即可。

## 模型可见四问

1. **模型看到什么变了**：换模型后的首轮请求里，旧模型的 reasoning 不再以 text 出现；
   纯思考轮显示 `[Thinking removed]`。同模型会话零变化（`differentModel` 分支不触发）。
2. **token 影响**：固定前缀零增减；换模型轮次的输入按旧推理总量净减（无上限场景下
   减几十 K）。占位符固定 18 字符，有界。
3. **KV cache 影响**：切模型时前缀本来就要整体重建（modelKey 换桶），无额外作废；
   同模型轮次逐字节不变。
4. **注入上限**：无新增注入项；剥离是严格减法，占位符是固定短文本。

## ZCode 学习批的对照结论（避免重复建设）

| ZCode 机制 | RedCode 现状 |
| --- | --- |
| microcompact（旧工具结果清占位） | 已有：`compaction.ts` prune 档（260729，0.8 档、PRUNE_PROTECT 保护带） |
| 空补全重试 | 已有：`prompt.ts` `emptyTurnRetried`（260808）+ `reasoningOnlyRetried`（260728） |
| 实报 usage 驱动压缩 | 已有：`level()` 吃 `handle.message.tokens`（实报记账） |
| system 会话内缓存 | 已有：`prompt-caches.ts`（260617） |
| 易变内容尾部化（date） | 已有：`prompt.ts:1924`（260718）；env 块实测同项目跨会话稳定，无需重排 |
| 显式缓存断点 | 已有：`transform.ts applyCaching`（前2 system + 末2 消息，六协议）+ `cache-policy.ts` |
| 跨模型推理剥离 | **本 note**（原先降级成 text） |
| system-reminder 生命周期类型 / 三消息两断点 | 未吸收：前者是架构改造，后者收益被 RedCode 现有断点布局覆盖大半，留待评估 |

## 验证

- `test/session/message-v2.test.ts` 73/73（新增 2 条：剥离不降级、剥空补占位符；
  更新 1 条旧期望）。
- `test/session/prompt-caches.test.ts` + `prompt-eval-cases.test.ts` 30/30。
- `bun run typecheck` exit 0。
- 真机换模型会话的输入量对比待实测（`request-evidence` 的 tokens.input 前后对照）。

## 回链

- 代码：`packages/opencode/src/session/message-v2.ts`（`THINKING_REMOVED_PLACEHOLDER`
  与 differentModel reasoning 分支注释）
- CHANGELOG：[Unreleased] 2026-10-24 条目
