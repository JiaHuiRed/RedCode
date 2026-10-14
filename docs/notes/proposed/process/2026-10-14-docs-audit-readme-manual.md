# 文档审计：README / MANUAL / CONTRIBUTING / SECURITY / docs 计划文档

状态:proposed

> 审计日期：2026-10-14
> 基线：`JiaHuiRed/RedCode` `dev` @ `7edefd54`，版本 **0.12.9**（`packages/opencode`、`packages/desktop`、`packages/app` 三处同号）
> 性质：先做只读审计（登记「哪句错了、错在哪、回链是什么」），随后按用户指示实施批次 1–4，见文末「执行记录」；批次 5 三项需先拍板，未动。
> 范围：顶层 `README.md` / `README.en.md` / `MANUAL.md` / `CONTRIBUTING.md` / `CONTRIBUTING.zh.md` / `SECURITY.md`，以及 `docs/` 顶层四份计划文档与 `docs/plans/`、`docs/notes/README.md`。`docs/notes/` 下 1.3MB 历史笔记未逐篇审。

## 问题

文档是用户和后来者唯一会读的入口，但它是全仓最不容易被测试覆盖的部分——代码改了、CHANGELOG 记了，README/MANUAL 里的那句旧文案没人拦。本轮以最新基线为准，把「文档说 A / 代码是 B」逐条挑出来。

## 方法

1. **硬事实回代码**：文档里每一条可验证的事实（版本号、命令名、文件路径、配置键、技能名、CI 数量、性能数字）都回到源码/配置里核实，不靠印象。
2. **链接脚本全量校验**：扫相对 markdown 链接、反引号内 `.md` 路径、以及 `#锚点` 是否能在目标文档里找到对应标题。
3. **不预判**：`docs/` 下的历史规划文档按「当时的事实」读，只登记引用是否还指向存在的文件，不评价其方案本身是否仍成立。

## 结论

**共 15 项问题**：11 项事实过时（含 1 项同文档自相矛盾）、2 项内部矛盾、4 项表述/一致性。其中 **MANUAL.md 的 6 项最贵**——用户会照着它敲命令、找技能，错的直接浪费用户时间。

另核实 **13 项无误**，列在第四节，避免下一轮重复查。

---

## 一、事实过时（P1，会误导读者）

### A1. MANUAL §8 命令表仍列已下线的 `/tui-persona`、`/gui-persona`

- **现状**：`MANUAL.md:494-495` 把 `/tui-persona`「加载 TUI 灵魂人格」、`/gui-persona`「加载 GUI 灵魂人格」当现行命令列出。
- **事实**：同一份文档 `MANUAL.md:294`（§5.2）自己写着「旧 `/tui-persona`、`/gui-persona` 已弃用，不应再用来向当前会话手动加载另一份人格正文」。代码侧 `packages/opencode/src/cli/cmd/tui/soul.ts:6`：「261008 Red 旧 /tui-persona、/gui-persona 已下线（seed 与 home 的命令文件同撤），**不再解析别名**」。`seed/command/` 里也没有这两个文件。
- **性质**：既过时、又与同文档自相矛盾。见 B1。
- **建议**：从 §8 表删掉这两行。

### A2. MANUAL §8 命令表缺 `/soul` 与 `/lan`

- **`/soul`**：§5.2（`MANUAL.md:288`）教用户用 `/soul`，TUI 也确有该内置命令（`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:673` 的 `slashName: "soul"`），但 §8 表没列。
- **`/lan`**：`seed/command/lan.md` 是真实命令（打开/查看手机局域网远程访问入口），§8 表没列。
- **建议**：§8 补这两行。注意 §8 现在混了「`seed/command/` 文件命令」与「引擎内置命令」（`/soul`、`/busy-enter` 都属后者），可顺手在表下加一句区分。

### A3. MANUAL 的 skill 名 `memory-automation` 已不存在

- **现状**：`MANUAL.md:327`（§6.1）「内置自动化记忆系统（skill `memory-automation`）」；`MANUAL.md:539`（§9.1 表首行）同样写 `memory-automation`，触发词标「收工」「保存记忆」。
- **事实**：260902 已把 `memory-automation`（写侧）与 `consolidate-memory`（整理侧）**合并为 `memory`**，`seed/skill/memory/SKILL.md:15` 明确记了这次合并。实际触发词是「整理记忆」「记忆太长了」「memory 清理」「记忆归档」（同文件 frontmatter `description`）。
- **建议**：两处改 `memory`，触发词按 frontmatter 重写。

### A4. MANUAL §9.1「以上 11 个随仓库分发」数字与清单都不对

- **现状**：`MANUAL.md:551` 称 11 个，表内列 11 行。
- **事实**：`seed/skill/` 实际 **13 个**目录，`SKILL.md` frontmatter `name` 逐一核对为：`ce-code-review`、`defensive-agent`、`diagnose`、`effect`、`frontend-design`、`goal-automation`、`harmonyos-android-compat`、`memory`、`red-scribe`、`simplify`、`stop-slop`、`vision-autoagent`、`yuqi-slop`。
- **差异**：表里 `memory-automation` 名字错（见 A3）；**缺 `effect`**（Effect v4 编写/调试）、**缺 `harmonyos-android-compat`**（鸿蒙移植验证）。
- **建议**：改「13 个」并补齐两行。

### A5. MANUAL §6.4「关闭记忆」的指引已失效

- **现状**：`MANUAL.md:358` 教用户「移除 `instructions` 里的 `memory-automation`」。
- **事实**：`seed/redcode.home.jsonc:23` 的 `instructions` 已清空为 `[]`（260902），且 `memory-automation` 这个名字已不存在（见 A3）。**没有对象可移除**。
- **建议**：这段只剩「清空两份 MEMORY.md 内容 / 改 `instruction.ts` 重编」两条真实路径，删掉 `instructions` 那句。

### A6. MANUAL §10.1 隐私图用旧 Soul 文件名

- **现状**：`MANUAL.md:601` 画的是 `souls/{T,G}soul.md ← 你的人格（首启由内嵌模板播种）`。
- **事实**：首启实际播种的是 `souls/karina.md` 与 `souls/yuqi.md`（`packages/opencode/src/project/bootstrap.ts:66-67`；模板在 `packages/opencode/src/project/template/souls/`）。`Tsoul.md`/`Gsoul.md` 只是**迁移用的旧文件**（模板目录里留着），不是播种目标。§2.3 与 §1 写的是对的，只有这张图没跟上。
- **建议**：图上改 `souls/*.md`（或直接写 `karina.md` / `yuqi.md`）。

### A7. CONTRIBUTING 双版的 CI 数量过时

- **现状**：`CONTRIBUTING.md:49`「Three workflows, all Windows-only: `test` (unit + e2e), `typecheck`, and `audit`」；`CONTRIBUTING.zh.md:57` 同。
- **事实**：`.github/workflows/` 实际 **4 个文件**：`test.yml`、`e2e.yml`、`typecheck.yml`、`audit.yml`。e2e 已从 test 拆出（`27c611ea chore(ci): e2e 拆分 paths 过滤`）。
- **建议**：改「四个：`test`、`e2e`、`typecheck`、`audit`」，中英同步。

### A8. docs/ 计划文档里的死引用

| 位置                                                                     | 引用的文件                                                             | 事实                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/dsh-adoption-plan.md:5`、`docs/parallel-systems-plan.md:3`、`:197` | `tauri-migration-plan.md`                                              | 全仓不存在（`git ls-files` 零命中）                                                                                                                                                      |
| `docs/parallel-systems-plan.md:93`、`:100`、`:107`                       | `provider-parity-checklist.md` / `src/v2/provider-parity-checklist.md` | 全仓不存在                                                                                                                                                                               |
| `docs/agent-roles-plan.md:106`                                           | `seed/agent/plan.md`                                                   | `seed/agent/` 目录已撤（260828 起不播种 agent）                                                                                                                                          |
| ~~`docs/agent-roles-plan.md:370`~~                                       | `src/agent/definition/execute.md`                                      | **误报，不改**：该文档内部同时使用 `src/...`（相对 `packages/opencode`）与 `packages/opencode/src/...` 两种写法（前者如 `agent/agent.ts`、`session/llm.ts`），此处与前者一致，不构成错误 |

- **性质**：这几份是「权威底本」类文档，被 `sync-home.bat` 注释和彼此互相引用。指向不存在的文件会让后来者以为丢了东西。
- **建议**：历史文档按 `docs/notes/README.md` 的四态规则处理——若已落定，挪 `archived/`（冻结、不再引为现行权威）；若还要留，把死引用改成「原计划文件名（已移除）」并说明。

### A9. docs/plans/computer-use-proposal.md 写死本机绝对路径

- **现状**：`docs/plans/computer-use-proposal.md:5`「外部审计意见已合并：`E:\dwonload\RedCode_Computer_Use_Proposal_Review.md`」。
- **问题**：① 绝对路径进仓库，换台机器就是死引用；② `dwonload` 疑为 `download` 拼写错误。
- **建议**：改成仓库内相对路径（把那份 review 一并收进 `docs/`），或直接删掉这句来源说明。

### A10. docs/notes/README.md 的子目录清单不全

- **现状**：`docs/notes/README.md:20` 规则 4 列「按主题再分子目录：`architecture/` `feature/` `bug-fix/` `process/` `simplification/`」。
- **事实**：实际还有 `implemented/refactor/`、`implemented/testing/`。四态目录本身（`implemented`/`proposed`/`rejected`/`archived`）与规则 3 一致，无误。
- **建议**：把主题子目录改成开放表述（「如 `architecture/` `feature/` `bug-fix/` …」），或补齐。

---

## 二、内部矛盾

### B1. MANUAL 同一份文档里 §8 与 §5.2 对 `/tui-persona` 说法相反

见 A1。§5.2 说「已弃用」，§8 当现行命令列出。这是本轮最该先修的一条——用户读到哪一节取决于他翻到哪，两节都可能被当成真的。

### B2. README「两个子代理」与 sync-home.bat 注释「three subagents」矛盾

- **README**（`README.md:47` / `README.en.md:47`）：「两个子代理（explore 只读调研 · execute 读写执行）」。
- **代码**：`packages/opencode/src/agent/agent.ts:323-324` 只有 `explore: subagent("explore")` 与 `execute: subagent("execute")`；`packages/opencode/src/agent/definition/` 下也只有 `explore.md`、`execute.md`。
- **矛盾方**：`script/sync-home.bat:49` 的注释写「the three built-in subagents (explore/**advise**/execute)」。`advise` 全仓 grep 零命中。
- **结论**：**README 是对的，bat 注释过时**。建议修注释（代码注释也算文档面）。

---

## 三、表述与一致性（P2，需润色）

### C1. README 中英双版的「用户手册」列表编号错乱

- **现状**：`README.md:184-187` / `README.en.md:179-182`。markdown 列表标记是 `1. 2. 3. 4.`，但每条正文里嵌的是章节号 `1 · 2 · 3` / `4 · 5 · 6` / `7 · 8 · 9` / `10`。渲染出来是四条 `1,2,3,4`，正文却跳着念 1→2→3、4→5→6，看着像章节号写错了。
- **建议**：要么拆成 10 行真列表，要么去掉列表标记改成一个段落（章节号已在正文里）。中英同步。

### C2. MANUAL 的 Ollama 示例前后不一致

- `MANUAL.md:118`（§2.1）用 `qwen3.5:9b-q8_0`；`MANUAL.md:187-204`（§3.3）用 `qwen2.5-coder:7b`。两处都是完整可抄的示例，用户会疑惑哪个是推荐的。
- **建议**：统一一个模型，或在 §3.3 说明「这里换成另一个模型是为了演示 `limit` 字段」。

### C3. 提交 scope 清单与实际使用有出入

- **现状**：`CONTRIBUTING.md:43`、`CONTRIBUTING.zh.md:51`、`AGENTS.md:89` 三处都写 `core` `redcode` `tui` `app` `desktop` `sdk` `plugin`。
- **事实**：近 60 个提交实际使用频次为 `core`(18) `app`(11) `redcode`(8) **`notes`(5)** **`seed`(4)** **`opencode`(3)** **`ci`(2)** `tui`(2) `sdk`(1) `session` `script` `gitignore` `config` `version`。加粗的四个高频项不在清单里，而 `desktop` / `plugin` 几乎不用。
- **建议**：清单改成「常用：…（不限于此）」，或补上 `notes` / `seed` / `ci` / `opencode`。三处要同步改，否则又是新的漂移源。

### C4. `seed/skills/`（复数）是死目录

- **现状**：`seed/skills/improve-codebase-architecture/`（4 个文件）被 git 跟踪。
- **事实**：`script/sync-home.bat` 只处理 `seed\skill`（单数，第 24 行），`seed\command`、`seed\tool`、`seed\scripts` 各走各的；全仓 `grep "seed/skills"` 零命中。这个 skill **永远不会被播种**到 `~/.redcode/skill/`，引擎也不加载 `seed/`。
- **建议**：确认是有意保留（比如留作参考）还是漏搬迁；若是漏搬迁，挪进 `seed/skill/`。注意 MANUAL §9.1 的技能清单里也没有它，所以目前三处（目录、播种脚本、文档）是一致的「不存在」，只有文件系统里有。

---

## 四、已核实无误（列出以免下轮重复查）

| 文档声明                                                              | 核实结果                                                         | 回链                                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| 版本徽章 `0.12.9`                                                     | ✅ 三包同号                                                      | `packages/{opencode,desktop,app}/package.json`                    |
| `TypeScript 7.x`                                                      | ✅                                                               | 根 `package.json` `typescript: 7.0.2`                             |
| `Bun 1.3.x`                                                           | ✅                                                               | 根 `package.json` `packageManager: bun@1.3.14`                    |
| 编译产物 `packages/opencode/dist/redcode-windows-x64/bin/redcode.exe` | ✅                                                               | `packages/opencode/script/build.ts:97,124`                        |
| `redcode web --hostname 0.0.0.0`                                      | ✅ 命令存在                                                      | `packages/opencode/src/cli/cmd/web.ts:9`                          |
| 「局域网绑定必须设密码，没设直接拦下」                                | ✅ 硬拦不是 warning                                              | `web.ts:16-19` 注释 + `cli/network.ts` 的 `resolveNetworkOptions` |
| `$schema: https://redcode.dev/config.json`                            | ✅                                                               | `seed/redcode.home.jsonc:2`                                       |
| 「三语 i18n（zh / en / ja）」                                         | ✅                                                               | `packages/app/src/i18n/{zh,en,ja}.ts`                             |
| 三档权限 Plan / RedMind / Auto                                        | ✅ 且 `auto` 刻意不给 displayName（靠 capitalize 渲染成 "Auto"） | `agent.ts:257,273,303`                                            |
| 「两个子代理 explore / execute」                                      | ✅                                                               | `agent.ts:323-324`                                                |
| 性能数字 `7.28s → 5.71s`、`1.26MB`                                    | ✅                                                               | `CHANGELOG.md:1344`、`:1318`                                      |
| 「流式渲染每 tick 重算量降到 1/16」                                   | ✅ 实为「11.50MB → 0.72MB（16 倍）」                             | `CHANGELOG.md:1348`                                               |
| MANUAL 章节 1–10 与 README 引用的「第 4 章」                          | ✅ 对得上                                                        | `MANUAL.md:22-660`                                                |
| 相对链接 / 锚点                                                       | ✅ **0 死链、0 失效锚点**                                        | 脚本全量校验                                                      |

---

## 五、未覆盖 / 未验证

- 未逐字核对 `MANUAL.md:455-457` 的档位阈值示例（`step-3.7-flash` context 256k / usable≈224k、52%/70%/88%），需要时回 `session/prompt.ts` 重算。
- 未验证 README 的「GUI 支持详情与独立本地头像」（Soul 段）在 GUI 里的实际形态。
- 未起真 TUI/GUI 验证行为类描述（归档入口、`Ctrl+Shift+Backspace`、上下文圆环位置）。
- `docs/notes/` 下 1.3MB 历史笔记（约 60+ 篇）未逐篇审，只验了 `README.md` 的规则与目录结构一致性。
- 未审 `packages/*/AGENTS.md`、`packages/opencode/docs/*.md`、`specs/`。

## 六、建议处理顺序

1. **先修 A1–A6（MANUAL）**：用户直接照着做，错的代价最高；且 A1 是自相矛盾，读者无从判断。
2. **再修 A7（CONTRIBUTING 双版）**：一处事实，中英同步，改动最小。
3. **A8–A10（历史文档 / 规则文档）**：可批量，按 `docs/notes/README.md` 的四态规则决定「挪 archived」还是「补说明」。
4. **C1–C2 润色**：纯排版与示例统一。
5. **B2、C3、C4 需先定夺**：bat 注释要不要顺手改、scope 清单要不要扩充（三处同步）、`seed/skills/` 是有意保留还是漏搬迁。这三条不是「文档写错」，是「事实本身要先拍板」。

## 后果

- 按上面顺序实施后，`MANUAL.md` 是动得最多的文件（6 处）；其余都是单点。
- **识别签名**：以后看到「文档里的技能名 / 命令名 / 子代理数量」，先回 `seed/` 与 `packages/opencode/src/agent/` 数一遍——本轮 15 项里有 5 项（A1–A4、B2）都是「清单类内容跟不上增删」这一类。

## 执行记录（2026-10-14）

批次 1–4 已按用户指示全部实施，共 **10 个文件**；批次 5 未动（需先拍板）。

### 批次 1：`MANUAL.md`（A1–A6）

| 项  | 改动                                                                                                |
| --- | --------------------------------------------------------------------------------------------------- |
| A1  | §8 删掉 `/tui-persona`、`/gui-persona` 两行                                                         |
| A2  | §8 补 `/soul [ID]`、`/lan` 两行；表下加一句说明 `/soul`、`/busy-enter` 是引擎内置、不在命令文件里   |
| A3  | §6.1 与 §9.1 的 `memory-automation` → `memory`；触发词按 frontmatter 改为「整理记忆」「记忆太长了」 |
| A4  | §9.1 补 `effect`、`harmonyos-android-compat` 两行；「11 个」→「13 个」                              |
| A5  | §6.4 删掉「移除 `instructions` 里的 `memory-automation`」半句（该数组已是空）                       |
| A6  | §10.1 隐私图 `souls/{T,G}soul.md` → `souls/*.md`（karina / yuqi）                                   |

### 批次 2：`CONTRIBUTING.md` / `CONTRIBUTING.zh.md`（A7）

- 「Three / 三个 workflows」→「Four / 四个」，并拆出 `e2e`（Playwright）。

### 批次 3：docs 历史文档死引用（A8–A10）

- `docs/dsh-adoption-plan.md:5`、`docs/parallel-systems-plan.md:3`、`:197`：`tauri-migration-plan.md` 标注「已从仓库移除」。
- `docs/parallel-systems-plan.md:93`、`:100`：`provider-parity-checklist.md` 标注「已移除」。
- `docs/agent-roles-plan.md:106`：`seed/agent/plan.md` 标注「`seed/agent/` 目录已撤」。
- `docs/agent-roles-plan.md:370`：**误报，未改**（见 A8 表末行）。
- `docs/plans/computer-use-proposal.md:5`：删掉本机绝对路径 `E:\dwonload\...`，改为「原始 review 为维护者本机的外部文件，未随仓库分发」。
- `docs/notes/README.md:20`：主题子目录清单补 `refactor/`、`testing/`，并改为「按需增删」。

### 批次 4：润色（C1–C2）

- `README.md` / `README.en.md`：手册列表由「marker `1-4`、内容 `1..10`」改为与 `MANUAL.md` 目录 **1:1 对应的 10 项**有序列表。
- `MANUAL.md` §3.3：加一句说明该节 Ollama 示例与 §2.1 用的不是同一个模型，并链回 §2.1。

### 验证

- 相对链接 / 锚点全量重跑：**0 问题**（含新加的 `#21-添加-ai-模型`、`#52-选择-soul`）。
- `bunx prettier --check`：`MANUAL.md`、`docs/parallel-systems-plan.md` 原本规范、被我改乱后已 prettier 复位；`README.md` / `README.en.md` 在 HEAD 上本就不规范（「核心能力」表列宽，与本轮无关），**故意不跑 prettier**，以免制造无关 diff。

### 仍未动（批次 5，需先拍板）

- **B2** `script/sync-home.bat:49` 注释「three built-in subagents (explore/advise/execute)」——`advise` 全仓不存在，README 是对的。
- **C3** 提交 scope 清单（`CONTRIBUTING.md:43` / `CONTRIBUTING.zh.md:51` / `AGENTS.md:89`）只列 7 个，实际高频还有 `notes` / `seed` / `opencode` / `ci`；三处必须同步改。
- **C4** `seed/skills/`（复数）是死目录，`improve-codebase-architecture` 永远不会被播种。
