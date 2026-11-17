# Prompt Pin 消息快照：冷恢复不重放插件改写

状态：implemented

## 问题

0.19.1 综合审计 F-07：msgPin 与插件消息变换的稳定性。

`_caches.msgPin` 只在进程内存里钉住已发送消息的 parts，`PromptPin` 落盘只存 tools/mcpGuide。冷恢复（重启续接、模型切换、进程缓存被回收）后 msgPin 为空，历史消息重新走 `experimental.chat.messages.transform`；而插件注入非幂等——memory-recall 按会话 seen 去重，检索结果随记忆库变化。同一条消息两次 pin 得到不同内容，前缀从改写点起整段失效。

实测证据（`~/.redcode/data/log/2026-11-17T182530.log` 与 `185230.log`）：同一个 `msg.id` 在两个进程里各 pin 一次，长度 `1776` 与 `80`——一个是"原文 + 检索块"，一个是原文。审计另记 15:02 两个会话同时整段 miss。

## 决策

把已钉住消息的 parts 快照一起落盘，冷恢复优先复用：

- `PromptPin.VERSION` 2 → 3，`Pin` 增加 `messages`（按消息 ID 索引的 parts 数组）与 `nativeRevision`。旧 pin 靠版本号整体弃用重建，与 v1→v2 同一机制。
- 冷恢复灌入：`_caches.msgPin` 缺失时读盘，`nativeRevision` 不匹配则不灌入（native compaction 版本变了，旧快照作废）。只在缓存缺失时读盘，热路径零额外 IO。
- 增量落盘：本轮有新钉住消息（`cached > 0`）才写，写在 mcpGuide 可用的位置，避免用 `undefined` 覆盖文件里已有的 guide；tools 缓存缺失时跳过，下轮冷组装补写。
- `PromptPin.dropMessages`：compaction 结算只丢消息快照，tools/mcpGuide 继续复用。`settlePromptCaches` 里同步调用——压缩改写必须在下一轮生效，快照留着会被钉回去，压缩白做且可能撑爆上下文预算。

## 取舍

- **检索新鲜度让位于前缀稳定**：冷恢复后模型看到的是上次注入的旧记忆块，不重新检索。想刷新等 compaction 或新会话。这是本决策的核心交换，不是疏漏。
- **体积硬上限 512KB/会话**：msgPin 钉的是完整 parts（含 tool 结果），DB 实测单会话 part 总量最高 289MB；原样落盘 × `DISK_MAX`(500) 会吃掉 GB 级磁盘。超限从最近的消息往前累计截断，至少保留一条——最近的消息才是被追加重写的那批。
- 快照按消息 ID 覆盖内存里的 parts，不做合并：与既有 pin 循环的"整条替换"语义一致，字节序不会因为拼接而改变。
- 插件若改写 assistant 消息，快照同样覆盖（落盘的是全部已钉消息，不筛选角色）；不与任何单一插件行为耦合。

## 模型可见四问

1. **模型看到什么变了**：正常运行路径无变化。冷恢复/模型切换后，历史 user 消息复用上次钉住的 parts（含插件注入块），不再重新 transform 出新的检索结果。
2. **token 影响**：固定前缀不变（本决策的目标就是让它不变）。冷恢复场景下历史消息的 token 数与上次发送时相同；对比修复前，省掉的是整段前缀重建（实测案例 321k token 全价）。
3. **KV cache 影响**：核心收益。修复前从改写点起前缀全部失效；修复后冷恢复的首请求可以直接命中上次的缓存前缀。
4. **上限**：单会话消息快照 512KB 硬上限（超出保留最近消息）；磁盘文件数沿用既有 `DISK_MAX = 500` + `PRUNE_EVERY = 200` 修剪。

## 验证

- `prompt-pin.test.ts`：消息快照往返逐字节一致、无快照时字段不出现、`dropMessages` 保留 tools/mcpGuide、512KB 截断（保留最近两条）、单条超限仍保留一条、快照结构损坏只丢消息不连累 tools、旧版本弃用。
- `prompt.test.ts` 新增端到端回归：非幂等 transform 在"第二个进程"注入不同内容（`[RECALL:1]` → `[RECALL:2]`），模拟冷恢复（同时清 `msgPin` 与 `modelMsgs`）后断言历史里那条消息的字节与首次发送完全一致。
  - 反向验证：临时置空 seed 后测试转红（`first question[RECALL:1]` → `first question`），恢复后转绿。只清 `msgPin` 不清 `modelMsgs` 会造成假绿——这是本轮实测踩到的坑。
- 全套件：`prompt.test.ts` 128 项（116 pass / 12 skip / 0 fail）；`prompt-pin.test.ts` + `prompt-caches.test.ts` 35 项全过；redspace typecheck 通过。

关联：[审计报告](../../../reviews/0.19.1-comprehensive-audit.md) §8。
