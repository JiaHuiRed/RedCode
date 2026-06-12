# 记忆系统

## 双层记忆（引擎自动注入，无需手动 /recall）

- **项目级** `<project>/.redcode/MEMORY.md` — 该项目特有的备忘与教训
  - 新项目首次启动时引擎自动创建空模板（前提：项目根既无 `.opencode/` 也无 `.redcode/`）
  - 工作中发现的**该项目相关**教训写这里
- **全局级** `~/.redcode/MEMORY.md` — 跨项目通用的历史教训
  - 项目级 MEMORY.md 不存在时，引擎自动注入全局级作为兜底
  - 收工时，有通用价值的教训从项目级反馈到全局级

## 记忆流动

- **全局 → 项目**：新项目首次对话，引擎注入全局 MEMORY.md（教训一次性吃到）
- **项目 → 项目**：后续对话，引擎注入项目级 `.redcode/MEMORY.md`（轻量，该项目专有）
- **项目 → 全局**：收工时，有通用价值的教训摘入 `~/.redcode/MEMORY.md`（不全量复制；复审长期库、删过时条目，保持精简）

## 优先级

- `.redcode/MEMORY.md` 为当前权威记忆源
- `.opencode/MEMORY.md` 是旧系统残留，**不作为权威记忆源**——遇到冲突以 `.redcode/` 版本为准，以全局 AGENTS.md 规则为准
- `~/.redcode/USER.md`（用户画像）由 `redcode.jsonc` instructions 自动注入，已在上下文

## 当日日志

- `~/.redcode/memory/YYMMDD.md`（日期格式 `YYMMDD`，如 `260611`）
- **一旦出错/返工/被纠正，当下立刻写入**，不等收工、不靠"记住了"
- 大任务前：读最近 3 天日志

## 自检触发点（每次收尾/提交/推送前）

1. 改了代码 → CHANGELOG 有没有同步更新？
2. 改了版本号 → **版本更新 checklist 全过了吗**（见下方「版本与文档」）？
3. 改了 README.md → **README.en.md 英文版同步改了吗**？（双语必须一起动）
4. 犯了错被纠正 → 当天日志写了没？
5. 做了不可逆操作 → 有没有先确认？
6. 上下文快满 → 派 explore 子代理而不是自己翻几十个文件？

## 跨项目工作规则

- **在别的项目里发现 RedCode 自身的 bug** → 记入当前项目的 `.redcode/MEMORY.md` 或当日日志，**提醒用户"这个问题属于 RedCode，请在 RedCode 工作区开对话修复"**。不要在当前项目 CWD 里改 RedCode 的文件（CHANGELOG/版本号/代码），CWD 不对会导致 commit scope 错、文件路径乱。
- **在别的项目里改了全局配置**（`~/.redcode/redcode.jsonc`、全局插件等）→ 全局配置可以改（路径是绝对的），但 CHANGELOG 条目属于 RedCode 仓库——**提醒用户"这条变更需要在 RedCode 对话里记录到 CHANGELOG"**。
- **项目级 `.redcode/MEMORY.md`** 只记该项目的备忘，不记 RedCode 的 bug/改动。

## 收工流程

1. 当日日志 → 摘**关键且需长期警惕**的教训 → 去重写入项目级 `.redcode/MEMORY.md`
2. 其中**跨项目通用**的 → 同时反馈到全局 `~/.redcode/MEMORY.md`
3. 复审长期库、删过时/已内化条目，保持精简
4. **连续失败 2 次** → 停下来问用户

# 身份加载（自动注入）

- **绑定**：GUI 人格 = `packages/desktop`；TUI 人格 = `packages/opencode`。
- **自动加载**：每次对话启动时，引擎自动注入对应人格源 `~/.redcode/souls/{T,G}soul.md`，无需手动触发。
- 人格源不存在时，读 `.opencode/agents/` 下的模板。

# 项目路由

RedCode = OpenCode fork：

| 目录 | 内容 | 入口 AGENTS.md |
|---|---|---|
| `packages/opencode/` | **TUI 核心** — CLI、plugin 系统、MCP、Effect、session | `packages/opencode/AGENTS.md` |
| `packages/desktop/` | **GUI** — Electron、main/renderer、sidecar | `packages/desktop/AGENTS.md` |
| `packages/app/` | **SolidJS Web UI** — 组件、路由、i18n | `packages/app/AGENTS.md` |
| `packages/plugin/` | Plugin SDK 类型定义 | - |
| `.opencode/` | 项目配置、skill、command、agent | - |

改所在 package 前先读**根 AGENTS.md + 对应 package 的 AGENTS.md**。两者都生效，scoped 规则覆盖根的代码细节（但记忆/git/路由规则不变）。

# 工作方式

任务循环（每步从简）：

1. **理解** — 读清需求。模糊或不可逆才停下来问用户，否则继续（详见 MEMORY.md 工作纪律）。
2. **定位** — 先用代码检索 MCP（**jCodeMunch > TypeGraph**，TS 类型感知优先），MCP 不可用或不足才退回 grep/glob/read。读到真实代码再动手，别假设。
3. **改动** — 只做被要求的事，最小改动；不顺手重构、不加没要的抽象/错误处理。改接口要更新所有调用方。
4. **验证** — 跑对应 package 的 typecheck/test，修好再继续。
5. **收尾** — 功能/版本完成后按 MEMORY.md 的自检清单逐项打勾。

- 4 步以上的任务先用 todo 拆解，一次只推进一项；琐碎任务直接做。
- **验证命令从 package 目录跑，别在 repo root 跑 `tsc`**：
  - 改 TUI → `cd packages/opencode && bun run typecheck`
  - 改 GUI → `cd packages/desktop && bun run typecheck`
  - 各 package 的代码风格/构建细节见该 package 的 AGENTS.md

## 编辑后自动验证（借鉴 RedsWhale LSP 钩子）

**每次 edit 源代码文件后，立即跑验证，不等任务结束。** 详见 `skill/auto-validate/SKILL.md`。

- 改了 `.ts` / `.tsx` / `.rs` → 立即 typecheck
- 改了测试文件 → 立即跑对应测试
- 批量改同 package 文件 → 合并验证一次
- 跨 package 编辑 → 分别验证
- 连续失败 2 次 → 停手问用户

# 红线（强约束）

- **不可逆/大动作先出计划、等用户批准**：删文件、`rm`、push、打包 release、amend/tag、改 DB schema/migration、改构建或 CI 配置、一次动 5+ 文件——先说方案、等点头，批准前只读不写。可逆小改直接做，别为难自己。
- **省 token（上下文短、免费模型尤甚）**：大范围探索派 `task` 工具的 `explore` 子代理（只读、专搜代码库、可指定 quick/medium/very thorough），只把结论摘要带回主线——别在主对话里一口气翻几十个文件，撑爆上下文触发 compact。回答先给结论、简洁、不复述用户的话。

# 版本与文档

- TUI（`packages/opencode/package.json`）与 GUI（`packages/desktop/package.json`）版本号**独立**，互不牵动。
- **版本更新 checklist（每次改版本号必须全过）**：
  1. `package.json` — 改版本号（TUI 或 GUI，看改了哪个 package）
  2. `README.md` — 中文版徽章更新
  3. `README.en.md` — **英文版徽章同步更新**（容易漏！双语必须一起动）
  4. `CHANGELOG.md` — 新版本条目（`## TUI` 或 `## GUI` 下）
  5. 标题栏徽章 — 自动注入（`package.json` → `__RC_VERSION__` 占位符），无需手改
  6. 自检脚本 — `script/check-version-consistency.ts`，build.bat 编译前校验
- 文档（版本号/徽章/CHANGELOG/README）可直接改好；**push / 打包 release 需用户确认**。

# 项目指令

- 默认分支 `dev`；`main` 可能不存在，对比用 `origin/dev`
- 缺信息/不可逆才问
- Commit: conventional commit `type(scope): summary`
  - types: `feat` `fix` `docs` `chore` `refactor` `test`
  - scopes: `core` `redcode` `tui` `app` `desktop` `sdk` `plugin`
- 不改 untracked 文件除非你要求
- 不擅自 push / amend / tag
- 重新生成 SDK：`./packages/sdk/js/script/build.ts`

# 代码规范

- 尽量避免 `try`/`catch` 和 `any`
- 优先用类型推断、Bun API、函数式数组（`flatMap`、`filter`、`map`）
- 优先 `const` + 三元/early return，避免 `else`
- 值只用一次就内联，减少变量
- 主函数读 happy path，细节抽 helper 放下面
- 测试测实际实现，避免 mock，从 package 目录跑
- 类型检查用 `bun typecheck`（package 目录），不跑 `tsc`

# 工作方法

**排查先看日志** — `~/.local/share/redcode/log/`，不猜原因

**连续失败 2 次 → 停手问用户** — 不闷头修

**模糊指令必须问清楚** — 严禁自己猜

**承认能力边界** — 做不到直接说"这个我做不到"

**被纠正立即记录** — 记入当日日志，不说"记住了"就完事

**搜代码先 MCP 工具** — jCodeMunch → TypeGraph，不足再 grep/read

**全面扫描再动手** — 不改一个重启一次

**删代码先搜全仓引用** — 删完 typecheck

**从工具到助手** — 减少指令数量比执行更多指令有价值

**灵魂是身份核心** — 每次对话前内化，不是文档

# 质量门禁（从 souls 提升，compact 不丢）

## 报告门禁（宁漏勿误）

以下情况**不报 bug**：
- 命名偏好、风格选择、"将来可能会……"
- 内部函数缺 defensive check（API 边界够了就行）
- 重复代码 ≤3 行

出 review/report 前问自己 4 个问题：
1. 可复现的 bug 或可测量的性能问题？
2. 完整上下文理解了（调用方、数据流）？
3. 建议不改变现有行为？
4. 不在上面的误报列表里？

少于 3/4 → 降级 note。少于 2/4 → 扔掉。

## 首次编辑不熟文件

第一次碰的文件，先扫 importers、看数据流、读测试（如果有），再动手。只改注释/CHANGELOG 不查。

## Guardrail 档位（ECC_PROFILE）

- `minimal` → 少确认快干
- `standard`（默认）→ 白名单自动放行
- `strict` → 每一步都问

## compress 工具用法（DCP 插件）

`compress` 只传 `topic`，**不传 `startId`/`endId`**——早期消息可能已被自动压缩吃掉，ID 过期会报错。DCP 后台自动裁剪（去重 tool 调用、截长输出）也在省 token。

## 协作模式

- `/goal <text>` — 钉住当前会话目标，子任务自动变 todos，完成打勾，`/goal clear` 清掉、`/goal done` 标完成
- `goal-automation` skill — 看到大任务时主动建议一次，但主动权在用户
- `/deepwork` — 更重的入口（先反问、再写 plan、一步步执行），不自动建议
