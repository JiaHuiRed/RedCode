# 指令文件会话中变更通知（Updated/Removed instructions from）

日期：2026-08-17 · 状态：implemented · 来源：DSH 采纳计划第二批「指令文件加载细节」

## 问题

DSH agent-instructions 在会话进行中指令文件变化时，给模型注入「Updated instructions from X」/「Removed instructions from X」通知。RedCode 没有对应机制，且有一个结构性理由让它更疼：

- 260617 起指令/技能/环境按会话+modelKey 缓存在 `_caches.system`（`session/prompt.ts`），`instruction.system()` 只在会话首次组装时读盘——这是前缀缓存稳定的刻意设计（每轮重读会因文件变化导致 system prompt 突变、DeepSeek 前缀缓存跳崖）。
- 代价：长会话中哥哥改了 AGENTS.md/铁律（或敏敏自己写了 MEMORY.md），模型无感知，继续按旧规则干活，直到新开会话才生效。

DSH 采纳计划第二批第 2 项列出三小条：①同目录 AGENTS.md/CLAUDE.md 内容去重 ②变更/移除注入通知 ③预算裁剪。本次落 ②，①已天然规避（见备选），③未做。

## 决策

1. **检测方式：每轮读盘对比内容，不比对 mtime**。mtime/size 方案省 IO 但不可靠（编辑器写回可能保持 mtime、内容级变更才是真信号）；指令文件总量 <100KB，读 + join 对比每轮开销毫秒级，且只在 `cachedSystem` 命中分支执行。
2. **通知形态：system 尾部一次性 push，不是 user 消息**。user 消息要构造 MessageV2 对象、进入 msgPin/modelMsgs 缓存序列，复杂度高且影响面大；system 尾部 push 与 Today's date（260718）同款模式——只在变化轮出现一次，下轮缓存已刷新、前缀稳定在新版本。变化轮前缀重排一次是「指令真变了」的合理代价。
3. **对比粒度：parts 数组按 `Instructions from: path` 头解析成 path→content map**，diff 产出 Updated（新增或内容变化）/ Removed（消失）通知，无变化返回 undefined。
4. **缓存刷新时机：检测到变化立即 `_caches.system.instructions = fresh`**，通知只出现一轮。

## 备选与否决理由

- **mtime 预检再读内容**：省每轮读盘，但引入「mtime 不变内容变」的漏检类 bug，弃。
- **user 消息形态**（DSH 原版）：语义上更接近「对话事件」，但 RedCode 的 msgPin/modelMsgs 前缀稳定机制要为此多打两个洞，改动面 ×3，弃。
- **同目录去重那条**：未动。RedCode 项目级指令 `systemPaths()` 本就是 first-match-wins（AGENTS.md 命中即不加载 CLAUDE.md），不堆叠就无重复可去。
- **预算裁剪那条**：未动。现有 64K chars 只告警不截断（260813），裁剪语义（先丢宽文件再截具体文件）与告警语义冲突，需要哥哥拍板后单独做。

## 后果

- `diffInstructionNotice` 导出为 `@internal Exported for testing`（上游 `createStructuredOutputTool` 同款模式），5 个纯函数用例在 `test/session/prompt.test.ts` 尾部 describe 块。
- 会话中改指令文件的轮次：system 尾部多一条通知（前缀重排一次），后续轮次前缀稳定在新版本。
- 未覆盖：config.instructions 里的远程 URL 指令不在对比范围（`instruction.system()` 的 parts 含 URL 内容，实际在对比范围内；remote fetch 失败返回空串会触发 Removed 通知——失败轮次会误报一次，可接受）。
