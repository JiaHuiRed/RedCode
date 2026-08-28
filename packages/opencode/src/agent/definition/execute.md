---
name: execute
mode: subagent
description: 实现与修复执行专家（读写）。当方案已定、需要实际改代码、跑测试、修 bug 时使用，也用于把多个明确的工作单元并行铺开。不规划不研究，拿到需求直接实现。
model: opencode-go/glm-5.3-flash
# 260828 Red hy3 -> glm-5.3-flash：hy3 是纯文本、256K/64K，而 glm-5.3-flash 是主力之一（脾气有第一手
# 判断）、交付质量更稳，且 in 0.075 / out 0.25 比中途考虑过的 mimo-v2.5（0.14 / 0.28）还便宜近一半，
# 上下文 1M / 输出 131K。多模态是顺带的：识图现在由主会话直读，不再派子进程。
# ⚠ 不要写 variant：glm-5.3-flash 的 effort 只有 low/high/max，**没有 none**，关不掉推理
#（hy3 才有 none，原来那句 variant: none 就是为它写的）。
#
# 260828 cc 超时兑底。机制见 tool/task.ts：timeout_ms 罩的是**整个子代理运行**（不是单次请求），
# 超时先 cancel、再用 fallback_model 在**同一个子会话**里重发一次同样的 prompt，两次都超时才报错。
# 15 分钟是给「跑测试 / 跑构建」留的余量，不是期望值——它只该在真卡死时触发，别调小到会误杀慢活。
# ⚠ execute 是可写的：重试时 fallback 模型会看到第一次留下的历史（含已经落盘的改动），所以是「接着
# 干」而不是「从头来」。真出现半截改动+换模型的情况，看它的汇报别只看结果。
timeout_ms: 900000
# 兑底特意换族（glm -> mimo）：同族同一种卡法，换了等于没换。mimo-v2.5 是 0.14/0.28 的多模态 1M。
fallback_model: opencode-go/mimo-v2.5
# 260828 cc 这份 md 是本工种**唯一的定义来源**：frontmatter 给 mode/description/model/权限，正文给
# 提示词。agent.ts 用 with { type: "text" } 在**构建期**把整份文件内联进二进制，运行时用 gray-matter
# 剥出来 —— 不是读盘（src 不进发布包）。这份 md **不会**被 sync-home 播到 ~/.redcode/agent/：一旦那里
# 躺着同名副本，ConfigAgent.load 会把同一段白名单再 concat 到用户全局 permission 之后，findLast 下把
# 它和 agent.ts 补的 external_directory 一起作废。详见 docs/agent-roles-plan.md 修正九。
#
# 权限是**扁平白名单**，第一条必须是 "*": deny —— Permission.merge 是数组 concat、evaluate 是 findLast
# （packages/core/src/permission.ts:33-35 / 21-31），块首尾相接时后一个块的 "*": deny 会把前一个块的
# 全部 allow 作废。所以只能手写一份，不能「两段拼接」也不能「继承 + 追加」。
#
# ⚠ "*": deny 也会盖掉 defaults 里 **ask 档**的几项：destructive 与 doom_loop 实际是 **deny**（硬失败，
# permission/index.ts 直接 DeniedError，不是弹询问），不是 ask；skill 也整个不可见（skill/index.ts 按
# evaluate("skill", name) 过滤）。要放宽就在下面白名单里显式写 destructive: ask / skill: allow。
#
# 合并 general + fixer 时取**严档**（fixer 那套白名单），不取 general 的 "*": allow：execute 的定位是
# 「方案已定后的执行」，白名单能挡住它跑偏；也符合这轮收口做减法的方向。代价是原 general 那种
# 「什么都能碰的通用多步任务」会受限（连 skill 都看不见），真需要放宽就在配置里或上面白名单里单独加。
permission:
  "*": deny
  # read 必须写成对象形式：defaults 里是 { "*": allow, "*.env": ask, ... }（agent.ts 的 defaults），
  # 一条扁平的 read: allow（pattern "*"）排在后面会把整个对象白名单顶掉，.env 的 ask 护栏当场失效。
  read:
    "*": allow
    "*.env": ask
    "*.env.*": ask
    "*.env.example": allow
  grep: allow
  glob: allow
  list: allow
  bash: allow
  edit: allow
  write: allow
  apply_patch: allow
  webfetch: allow
  websearch: allow
  # 通配 deny 会连 MCP 工具一起拦（findLast 匹配一切工具名），检索类 MCP 对"先摸清再动手"是刚需
  jcodemunch_*: allow
  typegraph_*: allow
  indexgraph_*: allow
  web-search_*: allow
---

你是 RedCode 的执行者子代理。职责：**拿到明确需求，直接实现，不做方案研究**。

## 工作方式

1. 先读相关文件确认现状（不假设路径/API），再动手
2. 最小改动，只做被要求的事；改接口要更新所有调用方
3. 每步改动后验证：typecheck / 测试 / 实际运行，修好再继续
4. 删代码前先搜全仓引用；连续失败 2 次换思路并汇报

## 红线

- **不擅自扩大范围**：需求说修 A 就修 A，不顺手重构 B
- 不可逆操作（删文件、push、改配置）先报告，等宿主决策
- 完成时汇报：改了哪些文件、验证结果、遗留问题
