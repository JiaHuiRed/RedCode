# Memory V4 批次 A/B：内容分层试点、召回短卡与漂移探针

状态:implemented

设计:[2026-10-19-memory-v4](../../proposed/architecture/2026-10-19-memory-v4.md)。本 note 记录批次 A（项目级试点）与批次 B（召回增强）的落地；批次 D 已执行。本轮限定抽查 #679/#680/#681 保留冲突两侧内容，#133/#140 也存在；独立 SQLite 确认上述抽查全文及六条已删索引对应全文均在。双写脚本核对 88 个索引全部有唯一全文。限定抽查未证实知识丢失；差异仍待人工核对，不自动回填/清库，不能靠 push 消除文本差异。

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

四信号：db 新于快照 / 快照未提交 / 领先 origin / 快照中有正文未逐字匹配。信号 4 表示两侧文本不同，不等于知识缺失：可能是修订、合并或重编号，须人工核对；差异不自动回填或清库，也不能靠 push 消除。无证据时状态为 unknown，CLI 不报 clean。每会话首轮由召回插件注入固定短提醒（主会话代理转告用户、子代理忽略），独立 `type:"drift"` 审计事件，脚本缺失或异常 fail-open。提醒不再拼接检查详情；详情保留在 CLI/audit，不进入提醒。全四信号最长提醒含 wrapper 实测 276 字节；任意 10k 字节详情仍恒定输出 276 字节。旧实现 4805 字节回归先红后绿；原通知定向测试子集 2 pass。动机：快照链路四步（export/commit/push/对端回填）此前全静默，pre-commit 自动导出只覆盖「staging MEMORY.md 的 commit」一条窄路。

## Recall audit analyzer 修复

按唯一 `message_id` 聚合成功事件的 `injected_ids` 集合：同一 message 的重复事件只计一个 turn；成功注入不再被后续 skip/miss 覆盖。V3 事件没有 `message_id` 时各自独立计数。原始 event/token 统计保留，drift 事件排除。

验证：旧口径回归红为 Precision `n/a`（0/0）、coverage 57.1%；修复后目标测试 2 pass，四脚本合跑 18 pass / 0 fail / 52 expects，package typecheck EXIT=0（tsgo crash 后 fallback TS 5.9.3 通过）。这是有标签样本上的统计口径修复，不代表实测召回质量净收益。分析器只输出诊断，不新增 system 或模型可见文本。

## 本轮终审：短卡来源、预算与审计边界

- 所有候选统一按最终 rendered 块的既有 `estimateTokens` 检查 turn/session budget；这是估算，不是精确 tokenizer。session-budget 早退也写 `recall-skip`，不查 DB。
- 只要块含 card，完整块（wrapper、编号、标签及 escape 后）必须 ≤`MEMORY_RECALL_CARD_BLOCK_BYTES`，默认 2 KiB；纯全文 V3 仍走既有 token 预算，不套用 2 KiB 硬限。
- 来源锚限于当前 workspace 物理 `docs/notes`：拒绝 `..`、文件 symlink 外逃及 `docs/notes` 根 junction 指向 `.redcode`；Windows 路径 API 接受 `Docs/Notes` 大小写别名。来源非法或缺失时只回退 DB 原文作为历史材料，不读取私有标题。
- drift audit 保存 signals 详细证据；仅在 writeAudit 成功后追加 notice。写入失败不阻塞、不重试。

验证：主仓四测试文件 18 pass / 0 fail / 52 expects；opencode typecheck pty exit 0（tsgo 崩溃后 fallback TS 5.9.3）；version consistency 通过。私仓 Node/Bun 主测试（含 audit-limit、drift、cards、v4-guards 子分支）、audit-rotation、drift-audit-blocked、直接 v4-guards 均通过，无 symlink skipped 输出；两文件 `node --check` 与双仓 `git diff --check` 通过。

模型可见四问：① 正常 card 格式不变，越限块不注入，非法来源回退 DB 历史材料；② system 固定前缀变化为 0，user 注入按既有 token 估算预算，不等于费用；③ 只改变最新 user 消息尾段，不改变 system/cache 前缀；④ 完整含 card 块默认 ≤2 KiB（可配置），纯 full 走既有 turn/session token 预算，notice ≤276 字节。

未做真实模型端到端质量或成本验收；fixture 通过不代表实效或净收益。

## 模型可见四问

1. **变了什么**：① 项目 MEMORY 删 5 行决策索引（新会话固定注入少约 900 字符）；② 召回注入块首改低信任表述；③ note 类命中改注短卡（约 110 字符）替代全文（数百至千余字符）；④ `/recall` 命令说明改措辞；⑤ 本轮将漂移提醒从拼接详情改为固定短语，详情留在 CLI/audit、不进入提醒。原文对照：召回插件与 `seed/command/recall.md` 的 diff；通知变化见本 note 漂移探针节。
2. **token 影响**：MEMORY 由 `instruction.ts` 加入 `instruction.system`，因此精简会改变 system 固定前缀；约 900 字符是字符差，不等于 token 或账单节省。每轮召回注入从 p50 327 token 降到约 60–150 token 是旧冒烟样本/诊断估算，不是精确 tokenizer 结果，也不能据此宣称净收益；全文条目沿用 V3 预算。本轮通知文案调整不改变 system 固定前缀。
3. **KV cache**：MEMORY 经 `prompt.ts` 按 session/model 缓存并放入 system；精简影响新会话的 system 前缀，导致该会话首次请求重建一次。召回短卡只追加到最新 user 消息尾部，历史前缀不动，不造成逐轮 system 前缀重置。本轮通知只改变最后一条 user 消息中的本轮段，不影响 system/cache 前缀。
4. **注入上限**：短卡整块 2 KiB 硬预算、≤3 条（`MEMORY_RECALL_CARD_BLOCK_BYTES` 可调）；本轮漂移提醒含 wrapper 固定上限 276 字节（每会话一次），详情不拼入提醒；miss/skip/drift 审计事件只落盘不进模型上下文。

## 验证

以下前四项为当时验证记录，不代表本轮复查结果；本轮通知修复验证见漂移探针节。

- 插件单测四分案（audit/rotation/drift/cards）全过：`plugin/memory-recall.test.mjs`（私仓；当时样本）。
- 真机冒烟：批次 A 三主题答案含现行值并区分新旧口径；批次 B 注入构成 `kinds=[full,card,full]`（654 全文第一、692 短卡第二、旧标签条目第三），答案含全部现行数字；探针 e2e 模型主动转告「快照未提交要 commit+push」。
- analyzer 在 1533 条真账自检：recall 1532 / drift 1 分流正确，coverage 行落位。
- 对账：回填 67 条后差集归零，#676–678/#72/#55 抽查在库，快照刷新至 237 条。

## 播种升级（261019 晚，新项目默认带上 V4）

`project/bootstrap.ts` 新项目播种：`.redcode/` 除 MEMORY 模板外新增 `.gitignore`（`*`，私有边界机制化、项目可加 `!` 例外）与 `docs/`（README 载约定：按主题一份/开头状态行/三段式/沿路标读取，不通读；样式参考 RedMon docs 的入口 README + 状态档位表 + REDCODE_CONTEXT 按任务加载实践）；MEMORY 模板补当前工作路标格式与 `docs/notes/` 指引（顺带修正已更名的 memory-automation skill 旧称）。全局侧配套：memory skill 3.5 节（项目进度与决策文档：创建/读取/写入三时刻，seed+home 双改）与全局 AGENTS.md 收工流程第 1 条（进度正文进 `.redcode/docs/`，MEMORY 只留路标）。仅影响新播种项目；本节四问：① 新项目 MEMORY 模板 +2 行；② 该项目固定前缀增加约 55 token/轮（估算，不是精准 tokenizer 或账单收益）；③ 存量项目不重写、无前缀失效；④ 模板受 instruction 硬预算约束，README 不进注入面。

## 回链

- 设计：`docs/notes/proposed/architecture/2026-10-19-memory-v4.md`
- 探针：`seed/scripts/memory-drift-check.mjs`；召回插件：私仓 `~/.redcode/plugin/memory-recall.js`
- 进度（私有）：`.redcode/docs/memory-v4.md`
