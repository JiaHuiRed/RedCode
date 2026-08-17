# 指令文件会话中变更通知（Updated/Removed instructions from）——已否决

日期：2026-08-17 · 状态：rejected · 来源：DSH 采纳计划第二批「指令文件加载细节」（19b2bed 落地后同日回退）

## 问题

DSH agent-instructions 在会话进行中指令文件变化时，给模型注入「Updated instructions from X」/「Removed instructions from X」通知。RedCode 没有对应机制，且有一个结构性理由让它更疼：

- 260617 起指令/技能/环境按会话+modelKey 缓存在 `_caches.system`（`session/prompt.ts`），`instruction.system()` 只在会话首次组装时读盘——这是前缀缓存稳定的刻意设计（每轮重读会因文件变化导致 system prompt 突变、DeepSeek 前缀缓存跳崖）。
- 代价：长会话中哥哥改了 AGENTS.md/铁律（或敏敏自己写了 MEMORY.md），模型无感知，继续按旧规则干活，直到新开会话才生效。

## 决策（原案）

1. 检测方式：每轮读盘对比内容，不比对 mtime。
2. 通知形态：system 尾部一次性 push，只在变化轮出现一次，下轮缓存已刷新、前缀稳定在新版本。
3. 对比粒度：parts 数组按 `Instructions from: path` 头解析成 path→content map，diff 产出 Updated/Removed 通知。
4. 缓存刷新时机：检测到变化立即 `_caches.system.instructions = fresh`。

## 否决原因（260817 同日实测）

**一次性通知与恢复轮前缀不一致 → 改一次指令文件 = 双重全灭**：

- 变化轮：system = 新指令 + `Updated instructions from ...` 尾巴 vs 上一轮（旧指令）→ 全灭①（断点在指令块 ~9K 处，其后 tools/conversation 全部重算，write ≈ 250K）
- 恢复轮：通知尾巴消失 vs 变化轮（带尾巴）→ 全灭②（write ≈ 250K）

原案假设"通知只出现一轮，下轮前缀即稳定在新版本"只保住了恢复轮**以后**，没保住恢复轮**本身**——尾巴的出现/消失必然让变化轮与恢复轮互为不同字节，两轮都付全价。与 466bb79"摘要请求跳过 reasoning"同款教训（head 必须与恢复轮逐字节一致）。

**实测数据**（ses_ffe5ff04a34beffeIH2Ho5q77HDq61，08-17）：模型 edit MEMORY.md 后下一轮 read=9216 / write=253154（3.5%）、再下一轮 read=15360 / write=245457（5.9%）。当天 7 次暴跌里 3 次源于此（19:43/19:57/21:07），总命中率被永久压低（write/miss 全价轮压累计，几百次正常轮摊不平一次暴跌）。功能 14:02 上线、当日即见效应——"为什么以前 compress 后只跌 70+、这两天直接 5%"。

**哥哥拍板**（260817）：当前模型价格不支持每轮读盘对比的代价；改完功能重开会话才适合。回退到 260617 缓存设计——会话中改指令文件不生效、下个会话生效（攒批改+重启）。

## 识别签名（防复发）

会话中 `edit`/`write` 命中 MEMORY.md / AGENTS.md / 任何 `systemPaths()` 指令文件 → 下一轮 cache read 掉到 ~9-15K（system 指令块位置）→ 双轮全灭。修复任何"会话中即时生效"类需求前，先过一遍"变化轮 vs 恢复轮逐字节一致"检查。

## 后果

- commit 19b2bed 整体回退（revert），prompt.ts 检测块/通知注入/diffInstructionNotice 及 5 个测试全部移除。
- `docs/dsh-adoption-plan.md` 勾选项改回并注明回退。
- 未来若重做：通知形态必须持久化（变化后每轮都带，或走 user 消息且进 msgPin），不能是"只出现一轮"的一次性尾巴。
