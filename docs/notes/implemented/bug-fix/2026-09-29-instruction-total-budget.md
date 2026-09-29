# 指令注入面总量上限：从「只告警」到「执行」

状态:implemented

## 问题

`Instruction.system()` 对固定前缀注入面有两道闸：单来源 `max_source_bytes`（默认 1MiB，
超限整份跳过）与总量 `max_total_bytes`（默认 64KiB）。**总量那道只告警不执行**——
260813 立下的原话是「不截断——截断会丢指令（漏掉铁律比前缀长更糟），告警只是把膨胀
暴露出来」。

判断没错，执行出了偏差：把「不截断」做成了「不设防」。实测本机五份注入
（全局 AGENTS 17.9K + 全局 MEMORY 11.0K + 项目 AGENTS 15.0K + 项目 MEMORY 8.5K +
soul 5.2K）合计 **56.4KiB，占 64KiB 预算 88%**。任何项目只要 AGENTS.md 再厚一点、
或多配一条 `instructions`，就越线——而越线之后除了日志什么都没发生，前缀继续涨。
「有上限」退化成了「有告警」。

## 决策

- 总量改为**执行**，但执行方式保留 260813 的核心顾虑：**绝不切半截文件**。按注入优先级
  从尾部整份丢弃来源（`sources` 顺序即 `systemPaths` 顺序：全局 AGENTS → 项目 AGENTS →
  全局 MEMORY → 项目 MEMORY → soul → config instructions），被丢的来源写进**模型可见的
  声明行**，模型知道哪些规则缺席了，可以主动提示用户去调配置。
- 只剩一个来源仍超限时，**截断它本身**并带显式标记（`[instruction budget] truncated at
  N bytes ...`）。理由：只剩一份还整份丢光的话，会话就一条指令都没有了，比半截更糟；
  而此时半截 + 明确标记优于静默丢光。
- 截断按**字节**二分找字符边界，不按字符数 `slice`。一个汉字 3 字节，按字符切会把多字节
  序列切成乱码，模型看到的是 U+FFFD 替换字符而不是指令（与 260916 修过的
  「字段名用 bytes、实现用字符数」是同一类坑）。
- 新增引擎级优先级声明行，置于所有来源之前：`The instructions below OVERRIDE any default
  behavior when they conflict.`。没有这句时，用户自己写的 AGENTS.md 与引擎默认提示词
  冲突，谁赢全靠模型自己猜。**没有任何来源时不输出**——没有"下面的指令"时这句话是纯噪音。

## 模型可见改动的四问

1. **模型看到什么变了**：注入块最前面多了一行英文声明（约 14 token）；总量超限时块尾多
   一段 `[instruction budget] ...` 声明行，列名被丢的来源路径。
2. **token 影响**：固定前缀 +14 token（声明行）。预算内会话零额外开销；超限会话额外
   +被丢来源路径列举，通常几十 token。
3. **KV cache 影响**：声明行插在 `instructions` 段首，而 `instructions` 位于
   `[...env, ...instructions, ...mcpGuide, ...skills]` 的第二位——`<env>` 在它之前，
   不受影响；**从声明行起往后的整个前缀作废一次**（mcpGuide / skills / 全部历史消息）。
   这是一次性成本，之后恢复稳定。选在这个位置而不是更早，就是为了让作废面尽量小。
4. **注入项有没有硬上限**：有。单来源 `max_source_bytes`（1MiB）+ 总量
   `max_total_bytes`（64KiB）。改造后总量是**真上限**：输出字节 ≤
   `maxTotalBytes + 标记行长度`，标记行本身有界（来源路径数量有限）。

## 备选与否决理由

- **恢复 260813 的纯告警**：否决——88% 占用率下它已经失效，继续等只会等到越线后无声膨胀。
- **无条件截断第一个来源**：否决——会静默切掉全局 AGENTS.md 的铁律，正是 260813 要避免的。
  改为「多来源先丢尾部整份，单来源才截断并标记」。
- **按字节数均摊裁剪所有来源**：否决——每份都残缺，比丢完整的一份更难读，也更难定位。

## 后果

- 超预算时降级路径确定：丢优先级低的整份 → 单来源截断 + 标记 → 日志 warn。任一环节都不静默。
- 本机当前 56.4KiB / 64KiB **仍在预算内**，本次改造不改变现状会话的注入内容（除声明行）。
  真正的行为变化只发生在越线时。
- 若用户认为 64KiB 偏小，调 `instruction_budget.max_total_bytes` 即可，不需要改代码。

## 回链

- `packages/opencode/src/session/instruction.ts`（`truncateToBytes`、`system()` 的总量执行段）
- `packages/opencode/test/session/instruction.test.ts`（`Instruction.system max_total_bytes`）
