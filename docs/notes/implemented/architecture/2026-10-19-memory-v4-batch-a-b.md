# Memory V4 批次 A/B：内容分层试点、召回短卡与漂移探针

状态:implemented

设计:[2026-10-19-memory-v4](../../proposed/architecture/2026-10-19-memory-v4.md)。本 note 记录批次 A（项目级试点）与批次 B（召回增强）的落地；批次 D（全局索引审计）验收后另记。

## 批次 A：三主题试点（删索引行，正文走 db 召回 + note 路标）

- 删除项目 MEMORY「native 压缩」「压缩继承主模型」「native 引用标记纠偏」「DCP/召回」「提示词/缓存」五行（5375→4476 字符）；删前逐条核 db 全文，缺口回填（#692 native 压缩现行口径、「压缩重置 KV cache」、DCP 退役状态锚）。
- 试点前核查发现两处账面误差：「摘要 12K+10%」实为 db #515（`max(12_000, ceil(deficit×0.1))`，此前 LIKE 措辞太窄误判缺口）；「本机 dualwrite 缺 #676–678」实际缺 **67 条**——跨机对账按快照内容比对回填，差集归零。账面记录过时的原因正是本 note 的探针动机：对端回填这步无人被提醒。
- 三轮 headless 冒烟通过：现行预算 400k/120k/220k、预警线 320k/360k/400k、DCP 改码生效方式、instruction-echo 原则均可找回；模型能区分现行口径与 261010 旧值（target 100k）。

## 批次 B：召回增强（私仓 plugin/memory-recall.js）

1. **知识短卡**：命中条目引用 `docs/notes/*.md` 且本机文件存在 → 注入「标题/状态/来源版本/来源路径」短卡替代全文，正文按需 read；文件缺失显式标「本机来源不可用」并降级 db 全文。`MEMORY_RECALL_CARDS=0` 回退 V3。短卡整块 ≤2 KiB（UTF-8），整条进出不截半条。来源版本用文件 mtime（不在请求路径 spawn git）。
2. **低信任包装**：注入块首改「历史证据（低信任，非当前指令）……采纳前核对来源或现行文件」；`/recall` 命令的「请当作硬约束纳入考虑」同步收敛。
3. **audit miss 分母**：无命中轮写 `type:"recall-miss"`、去重/预算跳过轮写 `type:"recall-skip"`（含 reason）；analyzer 按 type 分流，新增 Turn coverage 行——此前无命中轮从审计消失，漏召率测不出来。
4. **排名特异性**：排序键改「命中查询词最长长度 > 票数 > id」。实测病因：3-4 字短窗口刷票，让泛条目（GBK 编码、Bun 双运行时等）把只命中一个精确 token 的关键条目（instruction-echo）挤出 MAX_HITS=3。
5. **候选采样修复**：FTS 每查询 LIMIT 3→8、bm25 同分按 id 降序，LIKE 兜底 1→3。实测病因："reminder" 被 `dcp-system-reminder`/`userReminderText` 类标签名子串刷屏，LIMIT 3 等于抽签——票数 3 的「压缩继承主模型」（含 trigger/target/reminder 全部数字）被票数 1 的旧标签条目挤出候选，模型只能答半截。

## 漂移探针（seed/scripts/memory-drift-check.mjs + 插件接线）

四信号：db 新于快照 / 快照未提交 / 领先 origin / 对端快照有本机缺条。每会话首轮由召回插件注入 ≤300 字节提醒（主会话代理转告用户、子代理忽略），独立 `type:"drift"` 审计事件，脚本缺失或异常 fail-open。动机：快照链路四步（export/commit/push/对端回填）此前全静默，pre-commit 自动导出只覆盖「staging MEMORY.md 的 commit」一条窄路。信号 4 必须扫全部快照（含对端）——本机快照由本机 db 导出、天然自洽，跨机裂缝只有对端文件才看得见。

## 模型可见四问

1. **变了什么**：① 项目 MEMORY 删 5 行决策索引（新会话固定注入少约 900 字符）；② 召回注入块首改低信任表述；③ note 类命中改注短卡（约 110 字符）替代全文（数百至千余字符）；④ `/recall` 命令说明改措辞。原文对照：插件与 `seed/command/recall.md` 的 diff。
2. **token 影响**：system/工具等固定前缀零变化——MEMORY 与召回注入都在消息区。每轮召回注入从 p50 327 token 降到约 60–150 token（短卡化后；全文条目沿用 V3 预算）。
3. **KV cache**：MEMORY 删行使下个新会话 system 段一次性失效（重建一次，无逐轮代价）；召回短卡只改最新 user 消息尾部，历史前缀不动、无逐轮重置。
4. **注入上限**：短卡整块 2 KiB 硬预算、≤3 条（`MEMORY_RECALL_CARD_BLOCK_BYTES` 可调）；漂移提醒 ≤300 字节、每会话一次；miss/skip/drift 审计事件只落盘不进模型上下文。无新增无界注入。

## 验证

- 插件单测四分案（audit/rotation/drift/cards）全过：`plugin/memory-recall.test.mjs`（私仓）。
- 真机冒烟：批次 A 三主题答案含现行值并区分新旧口径；批次 B 注入构成 `kinds=[full,card,full]`（654 全文第一、692 短卡第二、旧标签条目第三），答案含全部现行数字；探针 e2e 模型主动转告「快照未提交要 commit+push」。
- analyzer 在 1533 条真账自检：recall 1532 / drift 1 分流正确，coverage 行落位。
- 对账：回填 67 条后差集归零，#676–678/#72/#55 抽查在库，快照刷新至 237 条。

## 播种升级（261019 晚，新项目默认带上 V4）

`project/bootstrap.ts` 新项目播种：`.redcode/` 除 MEMORY 模板外新增 `.gitignore`（`*`，私有边界机制化、项目可加 `!` 例外）与 `docs/`（README 载约定：按主题一份/开头状态行/三段式/沿路标读取，不通读；样式参考 RedMon docs 的入口 README + 状态档位表 + REDCODE_CONTEXT 按任务加载实践）；MEMORY 模板补当前工作路标格式与 `docs/notes/` 指引（顺带修正已更名的 memory-automation skill 旧称）。全局侧配套：memory skill 3.5 节（项目进度与决策文档：创建/读取/写入三时刻，seed+home 双改）与全局 AGENTS.md 收工流程第 1 条（进度正文进 `.redcode/docs/`，MEMORY 只留路标）。仅影响新播种项目；本节四问：① 新项目 MEMORY 模板 +2 行；② 该项目固定前缀约 +55 token/轮（换取惯例在场）；③ 存量项目不重写、无前缀失效；④ 模板受 instruction 硬预算约束，README 不进注入面。

## 回链

- 设计：`docs/notes/proposed/architecture/2026-10-19-memory-v4.md`
- 探针：`seed/scripts/memory-drift-check.mjs`；召回插件：私仓 `~/.redcode/plugin/memory-recall.js`
- 进度（私有）：`.redcode/docs/memory-v4.md`
