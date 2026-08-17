# goal 语义三件套（blocked 判定 / 明文排除 / resume 缴械）

日期：2026-08-17 · 状态：implemented · 来源：DSH 采纳计划第二批「goal 语义三件套」

## 问题

DSH 的 goal guidance（`packages/goal/tool-goal/src/index.ts:113-123`）给模型的 blocked 语义有三条：① 同一阻塞条件持续 ≥N 轮（默认 3，可配）才准标 blocked，且必须报具体条件；② `difficulty, uncertainty, or useful remaining work is not blocked` 明文排除；③ session resume/fork 后 goal 自动 disarmed，人类以任何措辞说"继续"（模型调 resume 工具）才 rearm。目标是对冲 V4 长程早停——模型一轮不顺就缴械。

RedCode 现状：activeGoal 注入（`session/prompt.ts`）只有一句 "keep working toward it; call goal_done when finished"，无 blocked 语义；task 子代理派活（`tool/task.md`）无纪律提示；goal 状态机有 `blocked` 状态（`session/goal.ts:13`）但无工具触发、无判定标准。

## 决策

1. **①+② 走提示词，不落库不加工具**：blocked 判定是模型自律语义（DSH 的硬阈值 `GOAL_TOOL_BLOCK_THRESHOLD` 依赖无人值守的 goal-round authority，RedCode 自动续跑默认关、轮次全由用户消息或 steering 触发，无 authority 概念可挂）；把三条语义写进 activeGoal 注入段（主会话模型）与 task.md（父模型派活时传给子代理）。零 migration、零新工具、改动面 2 文件。
2. **③ resume 缴械：天然覆盖，不做**。调研确认 RedCode 会话推进完全靠用户输入（`cli/cmd/run/runtime.ts:131` eagerStream 只是预连接，loop 由用户消息触发）——resume 后用户不发消息，没有 runLoop 就没有 idle 事件，goal-continuation 的 maybeContinue 无从触发；用户 resume 后发的第一条消息天然就是 DSH 所说 "human asks to continue or resume in any wording or language" 的隐式 rearm。RedCode 无 fork（Pi 清单"Session Tree 原地分支"未实现）。
3. 阈值取 3 轮（DSH 默认值），措辞对齐 DSH 原文风格但精简（两行）。

## 备选与否决理由

- **加 goal_blocked 工具 + blocked_reason 落库（DB 加列）**：能硬卡阈值，但需要 drizzle migration、新工具注册、reason 计数逻辑；RedCode blocked 场景是活跃会话（用户在场），模型文字汇报即可，工具是无人值守续跑才需要的表达通道。过度工程，弃。
- **resume 时把 goal 置 paused**：改变持久 goal 状态（DSH 明确 disarm 不动 durable phase），且 resume 后用户明说"继续"还要手动改回 active，绕。弃。
- **goal-continuation 加进程内 activation Map**：调研后发现 resume 流程已天然满足语义，无洞可堵，不需要额外状态。

## 后果

- activeGoal 注入段增加 2 行（仅 active goal 时注入，前缀成本可忽略）；task.md 增加 1 条派活纪律。
- 提示词改动影响模型可见内容：本会话 system 已缓存，下个会话生效（前缀缓存设计，非即时）。
- 未验证真实会话行为（无 goal 的会话不触发注入）；如哥哥要实机验证，新开会话钉 goal 观察模型卡住时的行为。