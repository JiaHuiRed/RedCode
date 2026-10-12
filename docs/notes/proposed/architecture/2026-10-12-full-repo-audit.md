# 全仓审计（三）：分歧标记 +45%，15 条里修 4 未动 8，以及两套零测试零节流的并行渲染栈

日期：2026-10-12 · 状态：proposed · 窗口：`034a8649..HEAD`（0.11.13 → 0.12.7，289 commit / 358 文件 / +29786 −5613，净 +24k 行）· 前两份：`2026-09-18-full-repo-audit.md`、`2026-09-24-incremental-audit.md`

> 本文全部条目由主 agent 在 HEAD 直接 grep/读码得出，**无子审计**（本轮五路并行子 agent 因额度中断，未产出结论）。每条标 **verified**（读了当前代码）或 **inferred**（只到 grep 层面 / 依赖推断）。
>
> **给下一个审计者的话**：两份前审计各有结论被仓内核验推翻（09-18 两条事实错误、09-24 五条判词被 §六 修正）。本文按同样标准使用——`proposed` 是候选队列，不是缺陷登记。**修复落地时 commit 回链本文 `§N`**。
>
> `bun run typecheck`（packages/opencode）本轮通过。

---

## 〇、先更正一份过时认知：DCP 已退役

`2026-09-24-incremental-audit.md` §3.3 与 §五 第 2 条（"seed/ 出 `dcp.jsonc` 模板 + 启动时比对 `modelMinLimits` 键并 warn"）**作废**。

- 迁移在 261010 完成，决策记录：`docs/notes/implemented/feature/2026-10-10-native-compaction.md`；`seed/redcode.home.jsonc:11` 明写"不再加载 DCP"，`:134-135` 出厂即 `compaction.native.enabled = true`。
- 阈值来源改为 provider 目录：`session/overflow.ts:9-19` 的 `usable()` 读 `model.limit.context / model.limit.input`，`config/native-compaction.ts:176-181` 按可用窗口等比 clamp trigger/target/reminder。**旧事故类（新模型未登记 → 静默回落 → 每轮压缩打穿前缀缓存）在结构上消失**——删掉了需要被告警的那个外部状态，比"加告警"是更正确的解。
- 残留（🟡 verified，作者已自行标注）：`overflow.ts:108-109` 记录 `usable = 0`（模型未声明窗口）时 native **不 clamp**、trigger 保持配置值/默认，与 legacy 的 `context === 0` 早退不一致。影响面仅 `limit.context === 0` 的模型（自建/本地端点），但仍是"不响"。
- 两条 `resolve()` 不传 usable 的调用点（`prompt.ts:1201`、`tool/context.ts:11`）经读码确认**只取 `enabled` 与预算值、不做触发判定**，判定路径都经 `compaction.ts:445` / `overflow.ts:44` 带 usable。**不是缺陷，别据此改。**
- 历史残留（非活路径，别当 bug 报）：`config.ts:184-185` 仍带不校验的 `dcp` passthrough 字段；`native-context.ts:38` `assertExclusive()` 是防 DCP 与 native 同时管理的护栏；`plugin/index.ts:232`、`transform.ts:164/:579` 的 DCP 字样是溯源注释。

---

## 一、头条：这不是打磨期的代码体量

| 指标 | 09-24 | 10-12 | 变化 |
| --- | --- | --- | --- |
| `// YYMMDD Red` 标记数 | 1034 | **1501** | **+45%** |
| 覆盖文件数 | 307 | **432** | +125 |
| 窗口净增行 | — | **+24,173** | +29786 / −5613 |
| refactor + perf commit | — | **6 / 289** | 2% |
| feat : fix | — | 36 : 99 | fix 主导 |
| 新增源码文件 : 新增测试文件 | — | 55 : 52 | ≈1:1 |

**判断（verified）**：commit 类型上确实是打磨期（fix 99 : feat 36，测试文件新增比 ≈1:1，typecheck 绿）；**代码体量与分歧面积上是扩张期**。打磨期应有的特征是标记数掉头向下——现在斜率比上一个 6 天窗口（559→598）更陡。增长**不是批量补注释造成的假象**：最大单文件只贡献 +14，分散在 125 个文件里。

增长最猛的仍是最大最热文件：`session/prompt.ts` 2229→**2469 行 / 69→83 标记**；`mcp/index.ts` 1565→1740 / 32→41；`app/src/context/directory-sync.ts` 732→**1073** / 8→18；`app/src/pages/session.tsx` 1839→2006 / 14→25。**下一次 upstream merge 的冲突面同比扩大**，且集中在最不该冲突的文件上。

---

## 二、记分牌：上一份 15 条的现状（verified，逐项实测）

| # | 条目 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | `tool.ts` 短路跳过模型侧预算 | ✅ **已修** | `tool.ts:166` 注释与代码一致，`truncated:false` 现在也过 fit；`:172/:184` 以 `outputPath` 判真 spill |
| 2 | 非图片附件计 0 + 无条数线 | 🟡 部分 | 条数线已中心化 `image-tokens.ts:93`、`:171` 统一门，`tools.ts:432/:559` 消费 ✅；**`attachmentRequestTokens` 对非图片仍返 0**（`image-tokens.ts:114-116`） |
| 3 | Timeline cache key/handle 跨会话别名 | ✅ 已修 | `message-timeline.tsx:355` 注释确认那组模块级 `let` 已删（grep 0 命中） |
| 4 | `working: () => true` 死分支 | ✅ 已修 | src 0 命中，仅剩 `prompt-input/submit.test.ts:441` |
| 5 | `Binary.search` → `searchBy` | 🟡 部分 | 总数 **38**（上次 34，**窗口内涨 4**）、`searchBy` 仍 **1**；`event-reducer.ts` 17 → **14** |
| 6 | `SYSTEM_TABS` 写侧未统一 | ❌ 未动 | `layout.tsx:132` `DEFAULT_SESSION_TABS.all = ["context"]` 原样；**`layout.test.ts:102/:109/:117/:125` 仍把 system id 断言进 `all[]`**（上次报 `:89-101`，现 `:98` 注释自陈"虚拟默认"即为此设计） |
| 7 | ~~DCP 缺键告警~~ | ⊘ 作废 | 见 §〇 |
| 8 | 模型注册跨表齐备测试 | ❌ 未动 | `grep CNY_PRICING\|ALLOWED_MODELS\|VISION_CAPABLE_MODELS` 在 test 目录 **0 命中** |
| 9 | GPT6 只更新 2/6 分发器 | ❌ 未动 | `GPT6_FAMILY_RE` 仅 `transform.ts:996/:1637`；`gpt5CodexReasoningEfforts:1005`、`:1013`、`:1213`、`freeform.ts:64` 仍只认 `GPT5_FAMILY_RE` |
| 10 | spill 写盘非原子 / 判龄静默删 / 清理无声 | ❌ 未动 | `truncate.ts:106` 非原子 `writeFileString`；`:98` `NaN >= cutoff` 为 false → 异形名**被静默删**；`:99` 清理失败 `Effect.catch(() => void)` |
| 11 | `event` 表零索引 | ❌ 未动 | `sync/event.sql.ts` 仅 `id` 主键，`aggregate_id` 是 FK + cascade **无索引**；热读 `control-plane/workspace.ts:722-723` 正按 `aggregate_id` 过滤；migration 全库 grep 无 index DDL |
| 12 | LAN 静默密码 | ❌ 未动 | `cli/network.ts:48` `LAN_DEFAULT_PASSWORD = "RedCode0429"` 在公开仓库，`:82` 无 env 时静默注入 |
| 13 | `bootstrap.ts` 吞错 | ❌ 未动 | `global-sync/bootstrap.ts:132` `showErrors({` 仍是注释态 |
| 14 | 工程卫生六条 | ❌ 全未动 | `.gitignore:31` 仍排除 `bun.lock`（本地 713KB 未跟踪）；workflows 仍 3 个（audit/test/typecheck）；`.oxlintrc.json` 4 `warn` / 0 `error`；`llm` 仍无 `test:ci`（其余 7 包都有）；`os.homedir()` 29→28（`mcp/index.ts:192` 展开 `~/` 仍在） |
| 15 | `packages/redcode` 死引用 | ⚠️ **数字修正** | 上次报 6 处，**实测 28 处**（见 §三 的污染说明）。指向不存在的包，散布在 `test/cli/tui/diff-viewer-file-tree-utils.test.ts`(14)、`script/raw-changelog.ts`(3)、`test/server/session-list.test.ts`(2)、`.github/workflows/test.yml` 等 |

**修 4 / 部分 2 / 作废 1 / 未动 8。**

**趋势规律复现且更强**：修掉的 4 条全部是当下咬用户的功能级 bug（工具预算、timeline、滚动），且 #1 的修复日期就是上一份审计**当天**（260924）。未动的 8 条全部是"要额外做一个闸门才会咬人"的基建/制度项。工程卫生六条**连续两轮零动作**。

一个正向对照（verified）：`69fb4e09`（261012）把 GUI `session-context-metrics.ts` 与 TUI `feature-plugins/sidebar/context.tsx` 的上下文档位**同 commit 对齐，并新增 `script/check-config-shadowing.ts`（90 行）闸门**。这是本仓第一次把"跨面一致性"从自觉变成机检——**这条应当作为模板复制，而不是作为孤例庆祝**。

---

## 三、测量陷阱：`.redcode/temp/` 781MB 源码副本

`.redcode/temp/RedCode-source-audit-20260920/` 是 9 月审计留下的一整份源码副本。**未进 git**（`.gitignore:74` 的 `.redcode/` 覆盖），但：

- 它让任何全仓 `grep` / 搜索工具的命中数**直接翻倍**。本文的 `packages/redcode` 从 6→78 的"暴涨"就是它的产物，剔除后真值 28。
- 它会污染后续任何"全仓统计"类结论，包括 agent 的。

**建议**：要么删（需维护者确认——属用户文件，本轮我只读未动），要么把 `.redcode/temp/` 加进本仓检索工具的 ignore 配置。**任何引用旧审计数字前先重测。**

---

## 四、结构性发现：三套消息实现，第三套已静默 6 周

| 面 | 体量 | 节流 | 测试 | 最后实质改动 |
| --- | --- | --- | --- | --- |
| `cli/cmd/tui` | **29,837 行** | 2 个文件（`feature-plugins/session/preview-pane.tsx:4,59`、`util/signal.ts:2,6`） | 有 | 活跃 |
| `cli/cmd/run` | **17,238 行** | **0 处** `throttle/debounce/schedule` | **0 个测试文件** | **2026-08-28** |
| `app` + `ui`（GUI） | 52,343 行（app） | 有 | 有 | 活跃 |

verified：窗口内 `cli/cmd/run` 净变化 **+27 行 / 1 个文件**，最后一次实质改动 8-28；`tui` 不 import `run`，`run` 只反向取 `tui` 的 `TuiConfig`/`TuiKeybind`（`runtime.boot.ts:10-11`）。

**代价不是"重复代码"这种抽象问题**，是：GUI/TUI 每修一次流式卡顿、每加一种消息类型，run 模式不会跟着好，**且没有任何东西会告诉你它没跟着好**。上一份的"GUI 有节流、TUI 零节流"就是这个机制的产物；现在 TUI 补上了，run 仍是 0——**同一类事故第四次发生只是时间问题**。

inferred：`grep markdown` 在 `cmd/run/` 命中 6 个文件（`scrollback.writer.tsx`、`footer.ts`、`entry.body.ts`、`tool.ts` 等），在 `cmd/tui/` 只命中主题 JSON。两边**很可能连 markdown 渲染器都不是同一个**。本条只到 grep 层面，未读实现，留给下一轮核。

---

## 五、本窗口新增代码：纪律是好的，缺口很集中

**做对的（verified，别回退）**

- **注入项硬上限**：`soul/index.ts:14-15` `MAX_SOUL_BYTES`/`MAX_SOUL_DESCRIPTION_BYTES` + `:149/:161` 双重校验；`context-compaction.ts:120-121/149/373/377/413` 每层超预算**一律 throw**，不静默裁；`request-evidence.ts:6/148` 复用 `session-evictor` 的 `MAX_SESSIONS` + TTL。
- **新代码 0 空 catch**：6 个新大文件（request-evidence / context-compaction / soul/index / soul/migration / gui-diagnostics / session-changes）空 catch 计数全为 0。
- `context-import.ts:30/:35` 旧 DCP 状态导入**抛错而非跳过**；`native-context.ts:38` `assertExclusive()` 主动挡住 DCP 共存。这是「误配置要响」的正解样本。
- `global-sync/event-batch.ts:4-6` 把 SSE 合并窗口抽成纯函数、修了 delta/快照**到达序**正确性（旧实现把同批出现过快照的 Part 的所有 delta 整批跳过），头注释回链"审计 GUI-02"。
- `pet/pet-layer.tsx:52-58` 定时器随 `petEnabled` 起落 + `onCleanup`；`gui-diagnostics.ts:78` 2000 条 / 512KB 双帽。
- **四问纪律明显进步**（但口径要说清）：窗口内 23 个改动 `session/prompt/` 或 `tool/` 的 commit，**21 个 body 提到 token / KV cache / 前缀**（上次 8 个里 2 个答满）。⚠️ **我的检测是关键词命中，不是"逐问答满"**——真实答满率应低于 21/23，别把这个数字当合规率引用。

**缺口**

| 严重度 | 条目 | 证据 |
| --- | --- | --- |
| 🔴 | **`soul/migration.ts` 318 行用户数据迁移零测试** | 无同名 test；含 `writeFileSync:30`、`throw error:37`、`existsSync:140`、多处字节帽。`writeSoulIfAbsent` 的幂等性靠命名约定而非断言。迁移失败 = soul 数据损坏且现场不可复现 |
| 🟠 | `config/native-compaction.ts:14-17` 四顶帽名义存在、实际等于无帽 | `MAX_TOKENS = 10_000_000`、`MAX_BODY_BYTES = 64MB`、`MAX_ACTIVE_BYTES = 256MB`、`MAX_SCAN_BYTES = 1GB` 作为**配置上界**。按红线，配置上界应贴着"模型能吃下的量"，不是"序列化不炸" |
| 🟡 | 5 个 ≥150 行新文件无测试 | `script/prompt-eval.ts` 619、`settings-personalization.tsx` 375、`soul/migration.ts` 318、`native-compaction.ts` 185、`acp/model-options.ts` 179 |

---

## 六、修复排序（按"代价 × 是否会被忘记"）

### 第一梯队：零行为变更 / 不可逆风险

1. **`sync/event.sql.ts` 补 `EventTable(aggregate_id, seq)` 索引 + 一条 migration**。热读路径 `workspace.ts:722-723` 正按 `aggregate_id` 过滤且**无 LIMIT** → 全表扫。上一份排在第三梯队是判错：它一直在烧 CPU，只是不报错误。（§二 #11）
2. **`soul/migration.ts` 补测试**：幂等重跑 / 超字节帽 / 目标已存在 / 写入中途失败 四个用例。（§五）
3. **每条"未动 8 条"改交付为会红的闸门**，不再进待办清单。已两轮实测：不进阻塞路径的条目零动作。优先级取"加了立刻红"的：`bun.lock` + `--frozen-lockfile`、`oxlint --deny-warnings`、`grep -rn 'Binary.search(' packages | wc -l` 不得增长（当前 38，且窗口内涨 4）、模型注册按能力条件化的齐备断言。（§二 #5/#8/#9/#14）

### 第二梯队：纪律与残留

4. `packages/redcode` 28 处死引用清一遍；同时处理 `.redcode/temp/` 污染。（§三、§二 #15）
5. `image-tokens.ts:114-116` 非图片附件给 token 下界（#2 的剩余半边）。条数/字节门已有，价格仍 0 ⇒ "长文本 + 巨型 PDF"组合仍不计入预算。⚠️ 上一份 §六 明确警告**不要按 base64/4 直接给 PDF 计价**（会把每个合法 PDF 判出局），应在共享边界设硬上限或按文档输入语义估价。
6. `truncate.ts` 一次改三处：`:98` 判龄失败偏向保留、`:106` 改 `writeFileStringAtomic`、`:99` 清理失败要响。（§二 #10）
7. `layout.tsx` 的 `all[]` 语义收窄 + **同步改 `layout.test.ts:102/:109/:117/:125`**。注意 `:98` 注释显示这是有意选择，属于"两种设计"而非纯 bug——先确认意图再动。（§二 #6）
8. `GPT5/GPT6` 家族表收成一张 `familyEfforts()`（5 个分发器共用）。（§二 #9）
9. `overflow.ts:108-109` 的 `usable = 0` 分支加 warn，替换掉现在那条注释。（§〇）

### 第三梯队：需要决策，不是需要修

10. **`cli/cmd/run` 做一个决定**：并入 tui 的渲染路径，或显式声明冻结并在跨面修复清单里登记它。17.2k 行 / 0 测试 / 6 周静默，维持现状等于让第四次"漏了一个兄弟"必然发生。（§四）
11. `bootstrap.ts:132` `showErrors` 恢复、`network.ts:82` LAN 密码策略——这两条**从 09-18 挂到现在**，且密码那条是维护者自己曾主动收紧又放松的决策，需要的是**决定**而非分析。（§二 #12/#13）

---

## 附：本文数字的可复算口径

| 指标 | 命令 |
| --- | --- |
| Red 标记 | `grep -rEo '// *[0-9]{6} Red' packages --include=*.ts --include=*.tsx \| wc -l`（对比基线用 `git grep -Eo ... 034a8649`） |
| `Binary.search` | `grep -rn 'Binary\.search(' packages --include=*.ts --include=*.tsx \| wc -l` |
| 死引用 | **必须排除 `.redcode/temp`**，否则翻倍 |
| 体量 | `git diff --stat 034a8649 HEAD -- 'packages/*.ts' 'packages/*.tsx'` |
| 未测新文件 | 对窗口内新增 ≥150 行的非 test 文件按 basename 找同名 test |

**未验证 / 能力边界**：markdown 渲染器是否两套（§四 inferred，只到 grep）；四问"答满率"（§五 只做了关键词命中）；`session/compaction.ts` 与 `context-compaction.ts` 的 legacy/native 双路是否有行为分叉未测——只确认 seed 默认 `enabled: true`，**没有逐条比对两条路径的输出**。这三处是下一轮 RedCode 自审最该打的点。
