# 记忆系统

- **项目根判定**：找到包含 `.git` 或 `redcode.jsonc` 的目录即为项目根（下文所有路径均相对项目根）
- **全局记忆/画像自动注入**：`~/.redcode/MEMORY.md`（教训/偏好/规范）与 `~/.redcode/USER.md`（用户画像）由 `~/.redcode/redcode.jsonc` 的 `instructions` 在每个项目启动时自动加载，已在上下文中；每换任务直接复用，无需手动读
- **当日即记（自动触发，别等开口）**：`~/.redcode/memory/YYMMDD.md` — **一旦自己发现出错/返工/走了弯路，或被用户纠正，当下立刻一句话写入当日日志**，不等收工、不靠"记住了"。错误只进当天日志，不直接写长期库。
- **自检触发点（每次收尾/提交/推送前过一遍）**：
  1. 改了代码 → CHANGELOG/README 有没有同步更新？
  2. 改了版本号 → 自检清单 5 项全过了吗？
  3. 犯了错被纠正 → 当天日志写了没？
  4. 做了不可逆操作 → 有没有先确认？
  5. 上下文快满 → 派 explore 子代理而不是自己翻几十个文件？
- **大任务前**：读最近 3 天日志
- **连续失败 2 次** → 停下来问用户
- **"下班"/"收工"/总结** → 从当日日志摘出**关键且需长期警惕**的教训，去重合入 `~/.redcode/MEMORY.md`。**不全量复制**；同时**复审长期库、删过时/已内化条目**，保持精简，防止长期库沦为每日日志的堆叠。
- **日期格式** `YYMMDD`（如 `260601`）

# 身份触发

- **绑定**：GUI 人格 = `packages/desktop`；TUI 人格 = `packages/opencode`。
- 触发方式（任一）：开场说"加载你的 TUI 人格"/"加载你的 GUI 人格"，或用命令 `/tui-persona`（TUI）`/gui-persona`（GUI）。
- 触发后读对应人格源：`~/.redcode/souls/{T,G}soul.md`。如果不存在则读 `.opencode/agents/` 下的模板。
- 在身份加载前，不预设任何身份。

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
2. **定位** — 先用代码检索 MCP（**jCodeMunch > TypeGraph > CodeGraph**，TS 类型感知优先；详见 MEMORY.md），MCP 不可用或不足才退回 grep/glob/read。读到真实代码再动手，别假设。
3. **改动** — 只做被要求的事，最小改动；不顺手重构、不加没要的抽象/错误处理。改接口要更新所有调用方。
4. **验证** — 跑对应 package 的 typecheck/test，修好再继续。
5. **收尾** — 功能/版本完成后按 MEMORY.md 的自检清单逐项打勾。

- 4 步以上的任务先用 todo 拆解，一次只推进一项；琐碎任务直接做。
- **验证命令从 package 目录跑，别在 repo root 跑 `tsc`**：
  - 改 TUI → `cd packages/opencode && bun run typecheck`
  - 改 GUI → `cd packages/desktop && bun run typecheck`
  - 各 package 的代码风格/构建细节见该 package 的 AGENTS.md

# 红线（强约束）

- **不可逆/大动作先出计划、等用户批准**：删文件、`rm`、push、打包 release、amend/tag、改 DB schema/migration、改构建或 CI 配置、一次动 5+ 文件——先说方案、等点头，批准前只读不写。可逆小改直接做，别为难自己。
- **省 token（上下文短、免费模型尤甚）**：大范围探索派 `task` 工具的 `explore` 子代理（只读、专搜代码库、可指定 quick/medium/very thorough），只把结论摘要带回主线——别在主对话里一口气翻几十个文件，撑爆上下文触发 compact。回答先给结论、简洁、不复述用户的话。

# 版本与文档

- TUI（`packages/opencode/package.json`）与 GUI（`packages/desktop/package.json`）版本号**独立**，互不牵动。
- 改版本号同步：`package.json` → README 徽章 → CHANGELOG（标题栏徽章自 0.3.17 起由 `package.json` 自动注入，无需手改；自检脚本 `script/check-version-consistency.ts`，build.bat 编译前校验）。
- 文档（版本号/徽章/CHANGELOG/README）可直接改好；**push / 打包 release 需用户确认**（由 MEMORY.md 中的规则控制）。

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

**搜代码先 MCP 工具** — jCodeMunch → codegraph → typegraph，不足再 grep/read

**全面扫描再动手** — 不改一个重启一次

**删代码先搜全仓引用** — 删完 typecheck

**从工具到助手** — 减少指令数量比执行更多指令有价值

**灵魂是身份核心** — 每次对话前内化，不是文档
