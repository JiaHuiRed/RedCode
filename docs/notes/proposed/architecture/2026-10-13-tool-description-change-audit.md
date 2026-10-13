# 工具描述分层改动 · 第三方复核（未提交工作区）

状态:已闭（261013 收口，保留为复核记录）。复核对象已提交（CHANGELOG「撤回工具规则上提，恢复原模型覆盖」）；§七.1 建议 B 已落实——emoji 与建文件纪律回到 `tool/edit.md`/`write.md`（模型无关载体），`default.md` 两句新增撤销；§五 的三处 DCP `compress` 死指令已清；§七.2 的 `write.md:7`/`read.md:9` 按建议 B 的原意留在 schema；§六 的 CHANGELOG 基数已随提交更正。本文不移至 archived/：CHANGELOG 现行段、`implemented/architecture/2026-10-13-tool-description-scope-review.md` 与 `proposed/architecture/2026-10-13-afternoon-batch-audit.md` 三处仍引用它。

## 问题

复核对象：工作区未提交改动（`packages/opencode/src/tool/{edit,write,grep,glob,read}.md`、`session/prompt/default.md`、`CHANGELOG.md`、`.gitignore`，以及笔记从 `proposed/` 移至 `implemented/`）。

复核立场：第三方。原审查（`2026-10-13-tool-description-scope-review.md`）是我写的，本次不复用它的结论，重新按判据逐条核对。

## 结论

**方向正确，判据应用大体一致，字节数与「四问」基本准确。但有一处结构性错误：把「与工具无关」的规则搬到了「与模型相关」的载体上，导致覆盖面缩小而非扩大。** 另有两处同类遗漏，一处我自己的前提错误需要更正，一处同类死指令顺带发现。

## 一、覆盖面核对（本次改动的核心问题）

`session/system.ts:63-121` 的提示词分支**共 16 条**，分两类：

- **6 条走 `withDefaultPrompt`**（与 `default.md` 叠加）：`gpt` / `deepseek` / `mimo` / `glm·qwen` / `step` / 兜底。
- **10 条返回独立全量文件**（**不**加载 `default.md`）：`gemini` / `claude` / `trinity` / `kimi` / `minimax` / `ollama+qwen` / `ollama` / `hy` / `grok` / `sensenova`。

即：**`default.md` 是兜底层，不是全局层。** 10 个独立文件是各自模型的**唯一**提示词。

改动前，emoji 规则与建文件纪律都住在 `edit.md` / `write.md`——**工具 schema 与模型无关，所以是全模型覆盖**。改动后：

| 规则 | 改前覆盖 | 改后覆盖 | 丢失的分支 |
| --- | --- | --- | --- |
| emoji | 全 16 条分支 | **6 条**（仅 `default.md:31` 一份） | claude / gemini / kimi / minimax / trinity / ollama / qwen / grok / hy / sensenova |
| 建文件纪律 | 全 16 条分支 | **9 条**（`default.md:30` + `anthropic.md:18` + `hy.md:38` + `sensenova.md:13`） | gemini / kimi / minimax / trinity / ollama / qwen / grok |

实测：`grep -ci emoji` 扫全部 21 个 `session/prompt/*.md`，**只有 `default.md` 一处命中**。

emoji 本身低风险，但**建文件纪律是实质工作规范**，且改前是硬措辞（`ALWAYS … NEVER write new files unless explicitly required`），改后 `default.md:30` 是软措辞（`unless it is necessary for the goal`）。对 7 条分支是「规则消失」，对全部 16 条是「强度下降」。

**净效果与改动意图相反**：意图是「规则对所有写文件的工具生效」，实际是「对所有模型中的一小部分生效」。

## 二、我自己的前提错了（须更正原审查）

原审查的「三层归属」表把第二、三层都写成 `system prompt`。**在本仓这是错的**——system prompt 按模型切分，不存在统一段。

本仓真正**与模型无关**的产品级提示词载体只有三个：

1. **工具 schema（`tool/*.md`）** —— 与模型无关，与工具相关。
2. `system.ts` 代码构建段（`<env>` 块）—— 与模型无关，但语义已占用于环境事实。
3. 指令层（`instruction.ts` 注入的 `~/.redcode/AGENTS.md` + 项目 `AGENTS.md`）—— 与模型无关，但属用户配置；`seed/` 下无 AGENTS 模板，不是产品载体。

**推论**：原审查的判据「删掉这个工具后规则还成立吗」依然有效，但它只回答**「该不该住在工具里」**，不回答**「该搬到哪」**。「搬到 prompt 层」在这个架构下等价于「搬到部分模型」——所以需要**第二条判据**：

> **搬走之后，谁还看得到它？** 若规则要求全模型生效，目标载体必须与模型无关。

按第二条判据，`default.md` 对 emoji 与建文件纪律是**不合格的落点**。

## 三、同类遗漏（判据应用不一致）

- **`write.md:7`** —— `NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.` 判据下删掉 `write` 工具后仍成立 → 全局规则，**仍在 schema 里**。且与 `default.md:30` 的 `No summary documents unless asked` 语义重叠。用户搬走了 emoji 与建文件纪律，漏了这一条同族规则。
- **`read.md:9`** —— `Use the grep tool to find specific content in large files or files with long lines.` 与已删的 `read.md:10`（read→glob 路由）**同类**，但保留了。**这一条是我上一版审查的漏项**（我只点了 line 10），改动照着我的漏项执行，漏项因此传导。

## 四、正面确认（改动做对的部分）

- **`write.md:6` 改判正确，且修正了我的分类错误。** `write.ts:49` 的 `FileTime.assert(ctx.sessionID, filepath)` 是**真运行时门**（覆盖已有文件前必须本会话 read 过且此后无外部改动），所以该句是工具自描述的失败模式，留 schema 正确。我的原审查把它归入 B 类（跨工具路由）是**错的**。用户的改判理由（「运行时真实校验」）准确。
- **字节数全部准确。** 逐文件实测：`edit −210` / `write −204` / `grep −262` / `glob −127` / `read −102` = **−905B**；`default.md` `9674 → 9997` = **+323B**；净 **−582B**。三项与 CHANGELOG 一致。
- **建文件纪律以 `default.md:30` 为单一真源、hy/sensenova 自带副本不动——对「该规则」成立。** hy.md / sensenova.md 确为独立全量文件（`system.ts:91` / `:110` 返回单元素数组），自带副本是唯一副本，不构成寄居。**但该推理只对该规则成立**：emoji 规则 hy/grok/sensenova **并不自带**，「不动」的结论因此对 emoji 失效。
- **`edit.md:50` 改为引用式、以生产端为真源，方向正确。** 唯一保留意见：这是**跨文件软引用**（`format <line>: <content> — defined in the Read tool description`），read 工具描述若被改动/禁用，该引用悬空。实际风险低（两者恒同现），但应在 `edit.md` 或 `read.md` 留一行注释点明这个耦合，否则下次改 read 的格式说明不会想到 edit 依赖它。

## 五、附带发现（不在本次改动范围，同一文件族）

**三处 DCP `compress` 死指令**：

- `kimi.md:42` / `minimax.md:44` / `ollama.md:64`（逐字相同）：`Proactively use DCP compress as context grows. NEVER wait for auto-compact — it destroys prefix cache and wastes money. Call compress early and often.`

而 `seed/redcode.home.jsonc:130` 已写明 **「261010 Red 原生压缩替代 DCP compress」**。这三条现在是**死指令**：指向一个已退役的命令，且「NEVER wait for auto-compact」与现状**方向相反**（原生自动压缩已是唯一机制）。属独立缺陷，建议单独一批处理。

## 六、更正项

1. **原审查的基数漏了一个文件。** 我只统计了 `tool/*.md`（非递归），漏掉 `tool/shell/shell.md`（1,293B）。真实工具描述面是 **25 个文件 / 25,848 字节**，不是 24 个 / 24,555 字节。
2. **CHANGELOG 的基数需更正。** `−905B` 的增量准确，但 `工具描述 24,555 → 23,650 字节` 应改为 `25,848 → 24,943 字节`（含 `shell.md`），否则数字与 `git` 对不上。
3. **原审查笔记的推理需补一条限定**：`hy/sensenova 互斥全量文件` 的结论只对「变体自带副本的规则」成立，不能推广到全部规则。

## 七、建议

1. **修覆盖面**（二选一）：
   - **A**：把两条规则补进 10 个独立变体 → 产生 10 份副本，回到 D 类漂移，**否决**。
   - **B（推荐）**：按第二条判据重新分工——**要求全模型生效的规则放回与模型无关的载体**（工具 schema，或代码构建段）；**分档调优内容留在各变体**。emoji 与建文件纪律属前者，应回到 `edit.md` / `write.md`（或另设一个代码构建的产品规范段）。改动意图（覆盖所有写文件的工具）则改由「在 schema 里集中一次、而非两处」来实现，而不是搬去 `default.md`。
2. 补 `write.md:7`、`read.md:9` 两处同类遗漏。
3. 更正 CHANGELOG 基数（见 §六.2）。
4. 顺手清掉 3 处 DCP `compress` 死指令（见 §五）。

## 未决

**未改动任何文件。** 这是对你未提交工作区的复核，不擅自改写。§七 第 1 条涉及模型可见面，动手前需你定 A/B。
