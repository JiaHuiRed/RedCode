# 这份文件的边界

**只写"RedCode 这个仓库长什么样"**：目录路由、构建/验证命令、代码风格、版本清单、分支与 commit scope、本仓特有的红线。

**"我该怎么干活"一律在全局 `~/.redcode/AGENTS.md`**：记忆系统、收工流程、跨项目规则、质量门禁、报告标准、compress 用法、协作模式、通用工作方法。两份**同时注入同一个 system prompt**（`session/instruction.ts:120-138`），这里重复一遍不会更"保险"，只会：① 每轮多付一份 token；② 两边各自演化后发出互相矛盾的指令。

---

# CORE（必须遵守，永远优先）

## 1. 先读代码再动手
绝不假设文件路径、函数名、API 存在。动手前搞清：改哪个文件、数据流怎么走、谁调用了它。

## 2. 失败后诊断再换方案
同一方案失败 1 次 → 停下看错误根因。2 次 → 强制换方向。换方案前必须向哥哥汇报：① 已确认的事实 ② 失败原因 ③ 新方案及依据。

## 3. 承认能力边界
拒绝过度自信，比起交付一个后续要返工或者回滚的任务，直接承认自己做不到会更好。

# 项目路由

| 目录 | 内容 | 入口 AGENTS.md |
|---|---|---|
| `packages/opencode/` | **TUI 核心** — CLI、plugin 系统、MCP、Effect、session | `packages/opencode/AGENTS.md` |
| `packages/desktop/` | **GUI** — Electron、main/renderer、sidecar | `packages/desktop/AGENTS.md` |
| `packages/app/` | **SolidJS Web UI** — 组件、路由、i18n | `packages/app/AGENTS.md` |
| `packages/plugin/` | Plugin SDK 类型定义 | - |
| `seed/` | **种子/暂存目录**（原 `.opencode/`，260805 改名）——skill、command、agent、配置模板。引擎**不**加载它，由 `script/sync-home.bat` 播种到 `~/.redcode/` 才生效 | - |

改所在 package 前先读**根 AGENTS.md + 对应 package 的 AGENTS.md**。两者都生效，scoped 规则覆盖根的代码细节。
注意包级 AGENTS.md **不自动注入**（引擎只取全局 + 第一个命中的项目级，见 `instruction.ts:127`），要自己 read。

# 验证命令

- **从 package 目录跑，别在 repo root 跑 `tsc`**：
  - 改 TUI → `cd packages/opencode && bun run typecheck`
  - 改 GUI → `cd packages/desktop && bun run typecheck`
- 各 package 的代码风格/构建细节见该 package 的 AGENTS.md
- 跑单测**必须带完整文件路径过滤**：不带过滤的 `bun test` 会碰 live 配置（260811 已修根因，但 plugin-loader 那类直接操作 live 文件名的用例仍靠路径隔离兜着）
- `bun run typecheck` 走 `script/typecheck.ts`：先跑 tsgo，崩溃（OOM/panic）时自动回退 TypeScript 5.x 重跑
- **子进程超时不变量**：`bun run check:subprocess-timeout`（已挂 pre-push）。新增 `appProcess.run` 调用点必须显式给 `timeout`，或在调用行上方写 `// subprocess-timeout: none — <理由>`。无界的子进程等待不触发 evloop drift 探针，挂起时日志里一个字都没有

## 编辑后自动验证

**每次 edit 源代码文件后，立即跑验证，不等任务结束。**

- 改了 `.ts` / `.tsx` → 立即 typecheck（从 package 目录跑）
- 改了测试文件 → 立即跑对应测试
- 批量改同 package 文件 → 合并验证一次；跨 package 编辑 → 分别验证

## 证据面匹配（永不默认全量）

**跑的检查必须匹配改动面，永远不要默认跑全量测试套件。**（260810 事故：想验一个测试却跑了全量 `bun test`，测试套件洗掉 live 配置——见 `docs/notes/`）

- 行为改动 → 只跑对应的测试文件（带路径过滤），**必须带包脚本的超时 `--timeout 30000`**——裸 `bun test <file>` 是默认 5 秒，session 套件会大面积假超时（判定指纹：失败耗时齐刷刷贴着超时值＝命令用错，不是回归；260808 实测，260814 复踩）
- 提示词/模型可见内容改动 → 对照该模型的实际会话验证
- 文档/版本号改动 → `check-version-consistency.ts`
- 构建路径改动 → 该 package 的 build
- 全量套件只在用户明确要求、或改动确属仓库级时才跑

# 本仓红线（通用红线见全局 AGENTS.md）

- **改一个函数前先数它的同形状兄弟。** 无法解释的不对称通常意味着漏了一次抽取，而本仓这件事**已经发生三次**：`edit.ts` 的 replacer 家族，07-22 修了 `fuzzyFindBestMatch`，07-24 号称"补齐其余 5 个"实际漏掉 `BlockAnchorReplacer`，08-19 审计才发现。**"补齐了"这个说法本身要复核——数一遍函数，别信上一次的收尾结论。** 来源：deepseek-harness 的 *unexplained asymmetry usually signals a missed extraction*。
- **误配置要响。** 自包含的在加载时响，否则在最早能解析的时刻响；**永远不要静默跳过一个解析不到的引用**。0.10.0 修过插件加载的三条静默失败路径（包解析到了但没有 server 入口只有 log.warn、整体超时把所有外置插件一起吞成空数组、`applyPlugin` 抛错处事件被注释掉只剩日志），当时是逐条补，没有立成规矩。
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
- **决策记录 `docs/notes/`，写与查双向**（规则与模板见其 README）：
  - **写**：非平凡改动同 commit 附 note。判据：一个月后会有人问"当时为什么这么做"就写。CHANGELOG 记 what，note 记 why。
  - **查**：动一个子系统前、或对"为什么这么设计"存疑时，先 `ls docs/notes/implemented/` 或按主题 grep——已否决的方案在 `rejected/`，别重新发明。
  - **链**：note 落地时在对应代码头注释/CHANGELOG 条目回链 note 路径——notes 不进上下文，靠链接网被发现。
- **模型可见改动的四问**（改提示词 / 注入段 / 工具 schema 与 description / 工具输出格式，必答）：在 commit 说明里逐条回答，有 note 的写进 note。
  1. **模型看到什么变了**——加了删了还是移了哪一段，给原文对照。
  2. **token 影响**——固定前缀增减多少（`session/prefix-shape.ts` 能直接量）。
  3. **KV cache 影响**——从哪一段起前缀作废，还是完全不动。**这条最容易漏、代价最大**：`19b2bed3`「每轮读盘对比 + system 尾部注入变更通知」就是没答这条落的地，在家实测对命中率造成破坏性损伤后整条回退；`image/image.ts` 的 resize 通知文案至今被钉成"只由尺寸推导、不含时间戳"，同一笔账——掺进去会让同一张历史图每轮生成不同文本，命中率线性掉到 50% 且不自愈。
  4. **注入项有没有硬上限**——任何进入模型上下文的东西都必须有确定的字节或 token 上限，**没有上限就是缺陷不是待办**。单项超过 1K token 在 commit 里单独点名；超过 10K 要说明为什么不能截断。本仓两次栽在这条：`tool/read.ts` 的文本分支有 `MAX_BYTES = 50KB` 而**图片分支一个上限都没有**（库里最大单条 3.23MB）；`summary.diffs` 无上限写回消息行（单行 32MB，占 message 表 79%）。两处都是"写的时候没人问上限"。来源：codex 的 Model visible context 第 3–5 条。
  段落顺序也算模型可见改动：**移动一段的代价是从它开始往后的整个前缀作废**，不是只有那一段。来源：deepseek-harness 的 "Model Experience 三问" 文档规矩，其 `sparse-first-party-prompt-section-orders` 一条就是在 Consequences 里主动写明了这个作废点。

# 项目指令

- 默认分支 `dev`；`main` 可能不存在，对比用 `origin/dev`
- Commit scope（types 与前缀规则见全局 AGENTS.md）：`core` `redcode` `tui` `app` `desktop` `sdk` `plugin`
- **重新生成 SDK 是两条命令，只跑第一条会漏掉 `packages/sdk/openapi.json`**（260820 cc 实测）：

  ```bash
  bun ./packages/sdk/js/script/build.ts                              # → packages/sdk/js/src/v2/gen/**
  cd packages/opencode && bun dev generate > ../sdk/openapi.json     # → packages/sdk/openapi.json
  ```

  第一条自己也会生成一份 openapi，但落在 `packages/sdk/js/` 下当临时输入，末尾 `rm` 掉，
  **不碰仓库里那份**。别跑 `script/generate.ts` 整脚本——它最后一步是 prettier 全仓 `--write`。

# 代码规范

- 尽量避免 `try`/`catch` 和 `any`
- **`catch` 要么处理要么说明**：空 `catch` 必须用一行注释写清它吞掉的是什么、以及为什么别的错误到不了这里；`try` 只包会抛的那一条语句。（`packages/opencode/src` 现有 97 处空的或无说明的 catch，不要求一次清完，新写的必须带说明。）
- 优先用类型推断、Bun API、函数式数组（`flatMap`、`filter`、`map`）
- 优先 `const` + 三元/early return，避免 `else`
- 值只用一次就内联，减少变量
- 主函数读 happy path，细节抽 helper 放下面
- 测试测实际实现，避免 mock，从 package 目录跑
- **注释格式** — 改动处加注释统一用 `// YYMMDD Red xxx`（6 位日期 + Red 标签 + 说明）。
