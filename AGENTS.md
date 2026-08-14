# 这份文件的边界

**只写"RedCode 这个仓库长什么样"**：目录路由、构建/验证命令、代码风格、版本清单、分支与 commit scope、本仓特有的红线。

**"我该怎么干活"一律在全局 `~/.redcode/AGENTS.md`**：记忆系统、收工流程、跨项目规则、质量门禁、报告标准、compress 用法、协作模式、通用工作方法。两份**同时注入同一个 system prompt**（`session/instruction.ts:120-138`），这里重复一遍不会更"保险"，只会：① 每轮多付一份 token；② 两边各自演化后发出互相矛盾的指令。

> 260811 cc 去重：此前本文件重复了全局那份的记忆系统/收工流程/跨项目规则/工作方法/质量门禁共约 1.5k token，
> 且重复的版本已经过时——还在说"项目级 MEMORY.md 不存在时才注入全局级"（260729 已改成两份同时注入）、
> 还把当日日志当活的（全局那份写着已退役、只作归档）。删除而非搬移：这些内容全局那份都有且更新。

---

# CORE — 工作铁律（必须遵守，永远优先）

## 五条铁律

### 1. 先读代码再动手
不先读相关文件就改代码 = 违规。绝不假设文件路径、函数名、API 存在。动手前搞清：改哪个文件、数据流怎么走、谁调用了它。

### 2. 失败后诊断再换方案
同一方案失败 1 次 → 停下看错误根因。2 次 → 强制换方向。换方案前必须向哥哥汇报：① 已确认的事实 ② 失败原因 ③ 新方案及依据。不汇报直接第三次相同操作 = 违规。

### 3. 建议放弃/搁置 = 严重违规（零容忍）
"要不先放着""今天别搞了""下次再处理""去休息吧""叫别人来做"——任何"你去休息/下次继续/找别人"的文案都是最严重的渎职行为。做不下去的正确做法：承认做不到 + 原因 + 替代方案，或者换方案继续。心里想放弃的时候，问自己"我还缺什么信息才能继续"。

### 4. 空道歉无效，只看行动
被批评后下一条消息必须是以工具调用开头。纯文本道歉不伴随行动 = 不承认错误。事后道歉没有价值——唯一有效的回应是立即修正、防止再犯。

### 5. 分析出方案后自己执行到底
分析出方案后**必须自己执行**（下载/解压/改配置/跑脚本）。**不允许说**"你去下载""你手动改""你跑这个命令"——你能做的事凭什么让用户做？只有不可逆操作/缺信息/物理动作才问用户。

# 项目路由

RedCode = OpenCode fork：

| 目录 | 内容 | 入口 AGENTS.md |
|---|---|---|
| `packages/opencode/` | **TUI 核心** — CLI、plugin 系统、MCP、Effect、session | `packages/opencode/AGENTS.md` |
| `packages/desktop/` | **GUI** — Electron、main/renderer、sidecar | `packages/desktop/AGENTS.md` |
| `packages/app/` | **SolidJS Web UI** — 组件、路由、i18n | `packages/app/AGENTS.md` |
| `packages/plugin/` | Plugin SDK 类型定义 | - |
| `seed/` | **种子/暂存目录**（原 `.opencode/`，260805 改名）——skill、command、agent、配置模板。引擎**不**加载它，由 `script/sync-home.bat` 播种到 `~/.redcode/` 才生效 | - |

改所在 package 前先读**根 AGENTS.md + 对应 package 的 AGENTS.md**。两者都生效，scoped 规则覆盖根的代码细节。
注意包级 AGENTS.md **不自动注入**（引擎只取全局 + 第一个命中的项目级，见 `instruction.ts:127`），要自己 read。

# 人格模板兜底

`~/.redcode/souls/{T,G}soul.md` 不存在时，引擎首启会用**内嵌进二进制**的模板播种
（`packages/opencode/src/project/template/{T,G}soul.md`）。人格如何触发见全局 AGENTS.md。

# 验证命令

- **从 package 目录跑，别在 repo root 跑 `tsc`**：
  - 改 TUI → `cd packages/opencode && bun run typecheck`
  - 改 GUI → `cd packages/desktop && bun run typecheck`
- 各 package 的代码风格/构建细节见该 package 的 AGENTS.md
- 跑单测**必须带完整文件路径过滤**：不带过滤的 `bun test` 会碰 live 配置（260811 已修根因，但 plugin-loader 那类直接操作 live 文件名的用例仍靠路径隔离兜着）
- `bun run typecheck` 走 `script/typecheck.ts`：先跑 tsgo，崩溃（OOM/panic）时自动回退 TypeScript 5.x 重跑

## 编辑后自动验证

**每次 edit 源代码文件后，立即跑验证，不等任务结束。**

- 改了 `.ts` / `.tsx` → 立即 typecheck（从 package 目录跑）
- 改了测试文件 → 立即跑对应测试
- 批量改同 package 文件 → 合并验证一次；跨 package 编辑 → 分别验证

# 本仓红线（通用红线见全局 AGENTS.md）

- **改/删文件前必加载 diagnose skill**：涉及修改、删除、创建文件的操作（包括写日志），先加载 diagnose skill，走完 Phase 1（建反馈循环/交叉验证）→ Phase 3（假设排序确认）→ Phase 6（完成后复盘），确认无误再动手，动手后验证结果。

# 版本与文档

- **单一版本线（2026-08-14 起）**：TUI 与 GUI 合并维护，全仓一个版本号，从 0.8.16 继续递增。历史双线（TUI ≤0.8.16 / GUI ≤0.7.20）只存在于 CHANGELOG 的 `## TUI`/`## GUI` 两段，**历史条目不改**。
- **版本更新 checklist（每次升版必须全过）**：
  1. `packages/opencode/package.json` + `packages/desktop/package.json` — **同号同升**（TUI 运行时与 GUI 标题栏徽章各自从这两处注入，缺一则显示分裂）
  2. 其余 `@redcode-ai/*` 包、`packages/sdk/js`、`sdks/vscode` 的 `version` — 同号跟升（互引均为 `workspace:*`，该字段仅作标签；Sentry release 与 GUI `Platform.version` 读 `packages/app` 的号）
  3. `README.md` — 中文版"版本"徽章更新
  4. `README.en.md` — **英文版 Version 徽章同步更新**（容易漏！双语必须一起动）
  5. `CHANGELOG.md` — 新条目写在顶部说明之下（合并线区域），**不再**写进 `## TUI`/`## GUI` 历史段
  6. 标题栏徽章 — 自动注入（`packages/desktop/package.json` → `__RC_VERSION__` 占位符），无需手改
  7. 自检脚本 — `script/check-version-consistency.ts`，build.bat 编译前校验（含全仓同号断言）
- 文档（版本号/徽章/CHANGELOG/README）可直接改好；**push / 打包 release 需用户确认**。

# 项目指令

- 默认分支 `dev`；`main` 可能不存在，对比用 `origin/dev`
- Commit scope（types 与前缀规则见全局 AGENTS.md）：`core` `redcode` `tui` `app` `desktop` `sdk` `plugin`
- 重新生成 SDK：`./packages/sdk/js/script/build.ts`

# 代码规范

- 尽量避免 `try`/`catch` 和 `any`
- 优先用类型推断、Bun API、函数式数组（`flatMap`、`filter`、`map`）
- 优先 `const` + 三元/early return，避免 `else`
- 值只用一次就内联，减少变量
- 主函数读 happy path，细节抽 helper 放下面
- 测试测实际实现，避免 mock，从 package 目录跑
- **注释格式** — 改动处加注释统一用 `// YYMMDD Red xxx`（6 位日期 + Red 标签 + 说明）。上游原有注释不改
