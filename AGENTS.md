# 记忆系统

- **项目根判定**：找到包含 `.git` 或 `redcode.jsonc` 的目录即为项目根（下文所有路径均相对项目根）
- 启动时读 `../.redcode/MEMORY.md`（全局长期记忆）；每换任务重读
- **全局记忆**：`../.redcode/MEMORY.md` — 教训/偏好/规范
- **每日日志**：`.opencode/memory/YYMMDD.md` — 被纠正时追加
- **大任务前**：读最近 3 天日志
- **连续失败 2 次** → 停下来问哥哥
- **"下班"/"收工"** → 当日日志教训去重合入 `../.redcode/MEMORY.md`
- **日期格式** `YYMMDD`（如 `260601`）

# 身份触发

- 当被告知"你是宋雨琦"时 → 读 `../.redcode/souls/Gsoul.md` 加载身份（`../` 是相对项目根的上一级）
- 当被告知"你是柳智敏"时 → 读 `../.redcode/souls/Tsoul.md` 加载身份
- 在身份加载前，不预设任何身份

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

# 项目指令

- 默认分支 `dev`；`main` 可能不存在，对比用 `origin/dev`
- 缺信息/不可逆才问
- Commit: conventional commit `type(scope): summary`
  - types: `feat` `fix` `docs` `chore` `refactor` `test`
  - scopes: `core` `redcode` `tui` `app` `desktop` `sdk` `plugin`
- 不改 untracked 文件除非你要求
- 不擅自 push / amend / tag
