# 全仓审计（四·定量层）：复杂度热点、依赖环、分包测试比与体量曲线 —— 补第三份缺失的可测结构面

日期：2026-10-12 · 状态：proposed · HEAD：`2ff9407e`（0.12.7） · 姊妹篇：[`2026-10-12-full-repo-audit.md`](2026-10-12-full-repo-audit.md)（同日，逐条验证层）

> **本文与姊妹篇互补，不重复其条目。** 姊妹篇做的是「逐条 grep/读码 → file:line 证据 → 修复排序」；本文补的是它**完全没有的那一面**：用 tree-sitter 符号索引得到的**可测结构量**（圈复杂度、依赖环、模块度、分包测试比、体量曲线）。姊妹篇的 15 条记分牌、`.redcode/temp` 污染、`cli/cmd/run` 静默、修复排序，本文一律不重述。
>
> **口径声明（本文第一条结论就是它）**：任何"全仓计数"类指标都**强依赖作用域与正则**。同一时刻的 `// YYMMDD Red` 标记，本文实测 **1071**（`packages/opencode/src` 内 + 人名白名单 + `grep -c` 按行），姊妹篇实测 **1501**（全 `packages` + 仅 `Red` + `grep -o` 按出现）。**两个数都能复现，都不是错的**——错的是不声明口径就当成真值引用。后文所有计数一律附命令。
>
> **给下一个审计者的话**：本文的复杂度是**静态估算**（tree-sitter 分支计数），不是运行时采样，用于**排序**而非判决。真正的行为判定仍须读码——姊妹篇的 §二 记分牌就是正确形态。

---

## 一、工具与可复算口径

本文全部结构量来自 [jcodemunch](https://github.com/jgravelle/jcodemunch-mcp)（tree-sitter AST 索引），本机实例：`E:\AI\RedCodemunch`。

```bash
# 索引（本仓 2467 文件 / 26358 符号，增量 110 文件变更，耗时 28s）
E:/AI/RedCodemunch/.venv/Scripts/python.exe -c "
import sys; sys.path.insert(0, r'E:\AI\RedCodemunch\src')
from jcodemunch_mcp.tools.index_folder import index_folder
print(index_folder(r'E:\AI\RedCode', incremental=True))"
```

⚠️ **本机坑（给下一个用这套工具的人）**：
- `E:\AI\RedCodemunch\cli\cli.py` 与 fork 后的工具集**不同步**（`get_symbol` 已改名 `get_symbol_source`），**直接跑会 ImportError**。绕过办法是 `import jcodemunch_mcp.tools.<name>` 直接调函数。
- `get_repo_health` / `get_untested_symbols` 在本仓规模下**极慢**（>15 min 未返回）。健康面改用 `get_architecture_metrics` + `get_hotspots` + `get_dependency_cycles` + `find_dead_code` 分项替代。
- `packages/sdk/openapi.json` 超 `max_file_size` 默认上限（512KB）**未入索引**，导致不可达分析 `signal_warning` 且**置信度封顶 0.6**（见 §四）。

| 指标 | 命令 / 工具 |
| --- | --- |
| 复杂度热点 | `get_hotspots(repo, top_n=40, days=120, min_complexity=2)` |
| 依赖环 | `get_dependency_cycles(repo)` |
| 集中度 / 深度 / 模块度 | `get_architecture_metrics(repo, top_n=10)` |
| 不可达 | `find_dead_code(repo, granularity="symbol", min_confidence=0.8)` |
| 分包测试比 | `find <pkg> -name '*.test.ts*'` vs 非 test 源码，`cat \| wc -l` |
| 各月体量 | `git ls-tree -r -l <commit> \| awk '/packages\/(opencode\|app\|ui\|core\|llm\|desktop)\/src\/.*\.(ts\|tsx)$/ {n++; s+=$4} END {print n, s}'` |

⚠️ **体量统计禁用「每月 × 每文件 `git show`」**：6 月 × 1300 文件 ≈ 7800 次子进程，本机实测 40 分钟未完成。`git ls-tree -r -l` 一次调用即给出全部 blob 字节数（字段 `$4`）。
⚠️ **本机 Git Bash 无 `bc`**：`| bc` 会静默产出空值且不报错退出，累加一律用 `awk`。

---

## 二、复杂度热点：前 5 名全是单个函数

`get_hotspots` 的口径是 **圈复杂度 × git 变更次数**（近 120 天）——改动最频繁的地方恰好最复杂。**姊妹篇没有任何复杂度数字，这是本文最直接的增量。**

| 函数 | 位置 | 圈复杂度 | 最大嵌套 | churn | 热点分 |
| --- | --- | ---: | ---: | ---: | ---: |
| `MessageTimeline` | `app/src/pages/session/message-timeline.tsx:313` | **439** | 10 | 50 | 1726 |
| `Page` | `app/src/pages/session.tsx:87` | **419** | 11 | 33 | 1478 |
| `Prompt` | `opencode/src/cli/cmd/tui/component/prompt/index.tsx:172` | **406** | **15** | 35 | 1455 |
| `PromptInput` | `app/src/components/prompt-input.tsx:131` | **416** | 8 | 27 | 1386 |
| `Session` | `opencode/src/cli/cmd/tui/routes/session/index.tsx:186` | **326** | 11 | 34 | 1159 |
| `createDirSyncContext` | `app/src/context/directory-sync.ts:220` | 252 | **17** | 20 | 767 |
| `custom` | `opencode/src/provider/provider.ts:162` | 196 | 9 | **36** | 708 |
| `Layout` | `app/src/pages/layout.tsx:82` | 252 | 8 | 13 | 665 |
| `SessionSidePanel` | `app/src/pages/session/session-side-panel.tsx:41` | 144 | 7 | 15 | 399 |
| `normalizeMessages` | `opencode/src/provider/transform.ts:97` | 100 | 10 | **39** | 369 |
| `selectProjectInteractive` | `opencode/src/cli/project-selector.ts:83` | 95 | **35** | 8 | 209 |

**读法**：业界把 10 当"该拆了"的门槛、20–30 当"明显过载"。**439 意味着静态路径就有 439 条分支**——没有人能在脑内验证它的行为。实测体量印证（粗测到下一个顶层声明）：

```
MessageTimeline   起始 L313  →  ~1928 行（单函数）
Prompt (TUI)      起始 L172  →  ~1876 行（单函数）
Session (TUI)     起始 L186  →  ~1450 行（单函数）
```

**两个不对称，值得单独记**：

1. `selectProjectInteractive` 圈复杂度只有 95（不高）但**嵌套 35 层**——这是"深层 if 金字塔"的指纹，通常可用早返回/查表消掉九成结构。churn 仅 8，不急，属"读一次骂一次"型。
2. `custom`(196) 与 `normalizeMessages`(100) 的 **churn 分别 36 / 39，是全场最高**。它们正是 8 月被重写的两个文件（见 §五），**印证「改得最多的地方就是最复杂的地方」不是巧合，是「每次改动都往里加分支」的累积效应**。

---

## 三、依赖结构：18 个环、17 层深度、集中度 0.70

`get_architecture_metrics` / `get_dependency_cycles`，2262 个可测文件：

| 维度 | 值 | 含义 |
| --- | ---: | --- |
| 最长依赖链深度 | **17** | GUI 入口 → base64 工具，见下 |
| 环数 / 环内文件 | **18** / 61 | 见下 |
| 模块簇 / 最大簇 | 56 / 953 | 最大簇含 953 个文件 |
| 孤立文件 | 247 | 无入无出 |
| 回边数 | 88 | DSM 视角的隐藏耦合 |
| Gini（字节/文件） | **0.7016** | 0=均摊，1=极集中 |
| Gini（fan-in） | **0.7715** | 被依赖高度集中 |
| Gini（fan-out） | 0.7149 | |
| Gini（符号/文件） | 0.6247 | |

**最长链（17 层）的实际路径**——说明 GUI 的上下文穿透深度：

```
entry.tsx → app.tsx → pages/session.tsx → composer/… → prompt-input.tsx
 → submit.ts → editor-dom.ts → history.ts → prompt-persistence.ts
 → context/file.tsx → layout.tsx → directory-sync.ts → server-sdk.tsx
 → global-sdk.tsx → language.tsx → platform.tsx → utils/base64.ts
```

**18 个环中值得记的三处**（其余为 schema ↔ 实现、生成代码 `client ↔ utils` 等结构性环）：

- `session/prompt.ts ↔ session/prompt/shell.ts` —— 上帝模块与其子模块互引
- `provider/provider.ts ↔ provider/transform.ts` —— 两个 2120 / 1902 行的大文件互引
- `session/message-v2.ts ↔ session/session.sql.ts` —— 域模型与 schema 互引
- 另：GUI 侧 `directory-sync ↔ global-sync/child-store ↔ server-sync` 三环闭合

**与姊妹篇的交叉**：姊妹篇 §二 #11 认定 `event` 表零索引是"第一梯队"，本文的环分析**支持该判断的严重性**——`sync` 相关文件已在环内，说明这条数据路径的耦合本身就不干净，加索引是低风险且必要的（但不足以单独解决耦合）。

---

## 四、不可达与测试覆盖形状

### 不可达：0，但置信度封顶 0.6

```
dead_symbol_count: 0    dead_file_count: 0    live_root_count: 107
min_confidence: 0.8
signal_warning: "the index withheld real source files (1 too_large) …
                 Confidence is capped at 0.6"
```

**这是一个强信号但不是证明**：`packages/sdk/openapi.json` 超 512KB 未入索引，它 import 的东西随之缺失。结论应表述为「**未发现不可达符号**」，而非「零死代码已证明」。姊妹篇未覆盖此项。

### 分包测试比：引擎侧教科书级，UI 侧断崖

| 包 | src 行 | 测试行 | 比 | 备注 |
| --- | ---: | ---: | ---: | --- |
| `opencode` | 134,699 | 101,535 | **75%** | |
| `core` | 12,757 | 9,722 | **76%** | |
| `llm` | 9,840 | 7,006 | **71%** | ⚠️ 姊妹篇 §二 #14：**仍无 `test:ci`**，其余 7 包都有 |
| `app` | 53,456 | 11,898 | 22% | |
| `desktop` | 5,641 | 863 | 15% | |
| `ui` | **23,586** | **749** | **3%** | 承担全部 GUI 渲染 |

**这是本文与姊妹篇合力才完整的结论**：姊妹篇发现 `cli/cmd/run` 17.2k 行 / 0 测试；本文发现 `ui` 包 23.6k 行 / 3% 测试。**两个零覆盖/近零覆盖区恰好是全部渲染实现**——引擎改错有测试兜，UI 与 run 改错只能靠人眼。

**关联的复杂度热点**：`ui/src/components/message-part.tsx`（2795 行、**91 个 `createMemo`**）正落在 3% 覆盖区里，而它是 GUI 消息渲染的全部承载者。`app/src/pages/session.tsx`（2006 行、**25 个 `createEffect`**）同理——25 个不可逆副作用散在 2006 行里，执行顺序难以推理。

SolidJS 用量（`packages/app/src` + `packages/ui/src`）：`createMemo` 685 / `createEffect` 173 / `createStore` 118 / `createSignal` 85。**memo 远多于 signal 是正确用法**（好信号）；集中度才是问题。

### 卫生计数（口径：`packages/{opencode,app,ui,core,llm,desktop}/src`）

| 项 | 数 | 判断 |
| --- | ---: | --- |
| `: any` / `as any` / `<any>` | 199 | 对 240k 行可接受 |
| `: unknown` | **569** | 远多于 any —— 成熟信号 |
| 空 catch（`catch {}` 形态） | 34 | 姊妹篇 §二 #13 已就 `bootstrap.ts` 单点定性 |
| `console.log(`（非 Effect Console） | 110 | 与包级 AGENTS.md 的 Console 约定冲突面 |
| TODO | 46 | 5 个月 / 240k 行，**偏低**（好） |
| `@ts-expect-error` / `@ts-ignore` | 18 / **5** | ignore 应清零（会静默失效） |
| `oxlint-disable` | 34 | 需逐个复核 |
| FIXME / HACK / XXX | **0** | 干净 |

文件体量：**111 个文件 > 500 行，30 个 > 1000 行**。注释率（行首注释 / 总行）：`opencode/src` 5%、`app/src` 3%、`ui/src` 2%——比例不高，但**存在处的密度极高且带实测数字**（见 §六）。

---

## 五、体量曲线：8 月的"负增长"是 i18n 裁撤，不是引擎瘦身

按月末快照统计 6 个主包 `src/**/*.{ts,tsx}` 字节总量：

| 月末 | src 文件 | src 字节 | 环比 |
| --- | ---: | ---: | ---: |
| 2026-05 | 1,214 | 8,202,777 | — |
| 2026-06 | 1,232 | 8,340,190 | +1.7% |
| 2026-07 | 1,253 | 8,576,663 | +2.8% |
| **2026-08** | 1,232 | **8,040,823** | **−6.2%** |
| 2026-09 | 1,309 | 8,846,436 | +10.0% |
| 2026-10 | 1,359 | 9,329,053 | +5.5% |

**8 月是提交量峰值月（538 次），代码量却净减 6.2%**——看似大重构。拆开看：

```
2026-07-31 → 2026-08-31（src 全量，git diff --numstat）
  新增 13,310 行 / 删除 23,112 行 / 净 −9,802 行
  其中 i18n：新增 363 / 删除 13,747 / 净 −13,384 行   ← 占净减量 137%
  ⇒ 非 i18n 代码实际净增 +3,582 行
```

**真相是一次产品决策，不是工程瘦身**：i18n 语言包从 **19 个**（ar / br / bs / da / de / en / es / fr / ja / ko / no / pl / ru / th / tr / uk / zh / zht）砍到 **3 个**（zh / en / ja）。剩余 9.7k 行删除分散在 `global-sync.tsx`（−520，重构进 `global-sync/` 目录）、若干被删组件，以及 `prompt.ts`(+893/−768)、`transform.ts`(+686/−410) 的重写。

**与 §二 的交叉印证**：8 月被重写的 `prompt.ts` / `transform.ts`，正是今天热点榜上 churn 最高的 `custom`(36) / `normalizeMessages`(39) / `options`(39)。**这不是巧合。**

---

## 六、与姊妹篇的交叉：三条互相加强的结论

| 结论 | 本文证据 | 姊妹篇证据 | 合起来说明 |
| --- | --- | --- | --- |
| 打磨期特征不成立 | churn 最高的是两个最复杂的大文件 | `Red` 标记 1501（+45%）、净增 +24k 行、refactor+perf 仅 6/289 | 提交类型像打磨，**结构与体量是扩张**——本文的复杂度热点是这一判断的微观佐证 |
| 缺口集中在渲染面 | `ui` 3% / `app` 22% / `desktop` 15% 覆盖；三个上帝组件全在渲染面 | `cli/cmd/run` 17.2k 行 / 0 测试 / 静默 6 周 | 三套渲染实现（run / TUI / GUI）**都没有测试网**，跨面漂移不会被任何东西发现 |
| 低风险高收益项存在 | 依赖环 18 条但多为结构性；不可达 0 | `event` 索引、`bun.lock`、`oxlint --deny-warnings` 等 8 条连续两轮零动作 | 真正的瓶颈不是"不知道修什么"，是**条目没有进入阻塞路径**（与姊妹篇 §二 判词一致） |

**本文对姊妹篇的一个补充修正建议**：姊妹篇 §一 用 `Red` 标记数作为"扩张期"的主指标。该指标**口径敏感**（见文首声明），且会随"给旧代码补注释"被动上涨。建议**辅以本文的复杂度热点 churn 列**——churn 是 `git log` 事实，不受注释习惯影响，更能反映"哪些文件真的在长"。

---

## 七、本文的能力边界

- 复杂度为**静态估算**（tree-sitter 分支计数），非运行时采样。用于排序，不用于判决。
- 不可达分析**置信度 0.6**（`openapi.json` 超索引上限），结论表述为「未发现」而非「已证明为零」。
- 依赖环基于 import 静态图，**未区分类型导入与运行时导入**，可能高估环数。
- 未做运行时验证：没有 profile、没有内存采样、没有真机 TUI/GUI 操作。**§二 的"1928 行单函数"是结构事实，"它慢"仍是推断**。
- 与姊妹篇相同：本文数字在 `docs/notes/proposed/` 状态下**不触发任何动作**。修复落地时 commit 回链本文 `§N`。
