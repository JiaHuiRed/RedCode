# RedCode 未来版本规划

> ECC（Everything Claude Code）实际是 OpenCode 的完整 plugin 库（不是 skill 文档集）。
> 260603 Red 真实情况：ECC 提供 12 agents + 31 commands + 9 plugin hooks + 8 custom tools + 300+ skills，
> 通过 `.opencode/plugin: ["./plugins"]` 直接加载到任何 OpenCode 项目。RedCode 就是 OpenCode fork，
> 所以 ECC plugin **可以原样装到 RedCode**（只需把英文 prompt 翻译成中文）。
>
> 本规划按"ECC 真能给的"和"需要自己写的"分类，**不再按昨天的错误分类**。

---

## 现实约束（260603 探索 ECC 后）

| 维度 | ECC 实际能力 | 适配 RedCode |
|------|-------------|--------------|
| 9 个 plugin hooks | TypeScript 实现，OpenCode plugin API | **直接移植**到 `packages/opencode/.opencode/plugins/`（需确认 RedCode plugin 加载路径） |
| 8 个 custom tools | TypeScript 实现，复用 `@opencode-ai/plugin/tool` | **直接移植** |
| 12 agents + 31 commands | YAML/Markdown 配置 + prompt 模板 | **直接用**（需汉化） |
| 300+ skills | Markdown 文档（最佳实践 + 示例代码） | **挑能用**的看（如 `error-handling`、`strategic-compact`） |
| RedCode TUI/GUI | 自己代码 | **完全自己写**，ECC 不碰 |

---

## P0 优先级（直接复用 ECC 代码）

### v0.3.14 — 引入 ECC plugin（基础接入）

**来源**: ECC `.opencode/plugins/ecc-hooks.ts` 完整实现

**目标**: 把 ECC 的 9 个 hooks + 8 个 tools 接入 RedCode，让 ECC 的能力在 RedCode 立即可用

**实现方向**:

1. **复制 plugin 源码到 RedCode**
   - `packages/opencode/.opencode/plugins/ecc-hooks.ts`（核心 520 行）
   - `packages/opencode/.opencode/plugins/lib/changed-files-store.ts`（辅助）
   - `packages/opencode/.opencode/tools/*.ts`（8 个工具）

2. **汉化 ECC 的英文日志/prompt**
   - `log("info", "[ECC] Formatted: ...")` → `log("info", "[ECC] 已格式化: ...")`
   - agent prompt 模板汉化（`prompts/agents/*.txt`）

3. **RedCode plugin 加载配置**
   - `redcode.jsonc` 加 `plugin: [".opencode/plugins"]`
   - 测试所有 hooks 能正常触发

4. **保留主人风格**
   - 不引入 ECC 的 `ECC_HOOK_PROFILE` 概念（按主人偏好用最简配置）
   - 不引入 desktop 通知（macOS 特定，主人用 Windows）

**涉及文件**:
- `packages/opencode/.opencode/plugins/ecc-hooks.ts`（新，从 D:\AI\ECC 复制）
- `packages/opencode/.opencode/plugins/lib/changed-files-store.ts`（新）
- `packages/opencode/.opencode/tools/*.ts`（新，8 个）
- `redcode.jsonc`（加 plugin 路径）
- `packages/opencode/.opencode/prompts/agents/*.txt`（汉化）

**收益**:
- 立即获得 Prettier 自动格式化、TS 类型检查、console.log 审计、PR 创建日志
- 立即获得 8 个工具（run-tests、check-coverage、security-audit 等）
- 立即获得 shell.env 注入（PROJECT_ROOT、PACKAGE_MANAGER 自动检测）

---

### v0.3.15 — 上下文压缩策略（基于 strategic-compact）

**来源**: ECC `skills/strategic-compact/SKILL.md` 决策指南表

**目标**: 在 RedCode TUI 端实现智能压缩（不只 hook 提醒，而是真正的"何时压缩"逻辑）

**ECC 给的关键决策表**（直接复用）:

| Phase Transition | Compact? | Why |
|-----------------|----------|-----|
| Research → Planning | Yes | 调研上下文冗长，plan 是精炼输出 |
| Planning → Implementation | Yes | plan 在 TodoWrite 里，腾出空间给代码 |
| Implementation → Testing | Maybe | 保留测试引用 |
| Debugging → Next feature | Yes | 调试 trace 污染下一阶段 |
| Mid-implementation | No | 丢失变量名/路径代价高 |
| After a failed approach | Yes | 清理死路推理 |

**实现方向**:

1. **CompressionManager** (`packages/opencode/src/context/compression-manager.ts`)
   - 策略：recent (最近 N 条) / important (token 消耗排序) / semantic (LLM 摘要) / hybrid
   - 触发：手动（用户点"压缩"按钮） / 自动（token > 90%）/ 预算（剩余 < 10% 强制）

2. **TUI 端压力检测 hook**（基于 ECC 的 `experimental.session.compacting`）
   - 在 `packages/opencode/src/session/compacting.ts` 接入
   - 调用 `CompressionManager.compress(messages, strategy)` 而不是默认 compaction

3. **GUI 端压缩提示**（基于 ECC 决策表）
   - 在 `packages/app/src/components/prompt-input/` 加压力指示器
   - 颜色：绿(<60%) / 黄(60-80%) / 红(>80%) / 红闪烁(>95%)
   - 点击展开：显示 token 分布（用户/助手/工具/系统）

**涉及文件**:
- `packages/opencode/src/context/compression-manager.ts`（新）
- `packages/opencode/src/session/compacting.ts`（修改，集成 ECC 决策）
- `packages/app/src/components/prompt-input/pressure-indicator.tsx`（新）
- `packages/app/src/hooks/use-context-pressure.ts`（新）

**收益**:
- 按 ECC 决策表智能压缩（不像 OpenCode 默认那样任意时刻压缩）
- TUI/GUI 双向都显示压力
- 减少上下文丢失，提升长会话质量

---

### v0.3.16 — 5 层 Error Hierarchy（基于 error-handling skill）

**来源**: ECC `skills/error-handling/SKILL.md` 完整 TypeScript 示例（376 行）

**目标**: 统一 RedCode 错误处理，提供更好用户反馈

**5 层错误分类**（直接复用 ECC 模式）:

| 层 | 类型 | 用户行为 | 示例 |
|----|------|----------|------|
| L1 | 网络错误 | 重试 | API 超时、DNS 解析失败 |
| L2 | 认证错误 | 检查配置 | API Key 无效、Token 过期 |
| L3 | 限额错误 | 等待/升级 | Rate limit、Quota exceeded |
| L4 | 模型错误 | 换模型/重试 | Context length exceeded、Model unavailable |
| L5 | 系统错误 | 联系支持 | 内部服务错误、未知异常 |

**实现方向**:

1. **复用 ECC 错误类**（直接 copy-paste）
   ```ts
   // packages/opencode/src/util/error.ts
   export class AppError extends Error {
     constructor(message, public code: string, public statusCode = 500, public details?: unknown) {
       super(message)
       this.name = this.constructor.name
       Object.setPrototypeOf(this, new.target.prototype)
     }
   }
   export class NotFoundError extends AppError { ... }
   export class ValidationError extends AppError { ... }
   // ... 等等
   ```

2. **Result pattern 集成**
   - `packages/opencode/src/util/result.ts`（新）
   - 用于 LLM 调用、API 请求、文件操作（失败是常见的场景）

3. **withRetry 工具**
   - `packages/opencode/src/util/retry.ts`（新）
   - 指数退避 + jitter，L1 网络错误自动重试 3 次

4. **ErrorToast GUI 组件**
   - `packages/app/src/components/error-toast.tsx`（新）
   - 根据 `error.code` 显示不同颜色 + 操作按钮

**涉及文件**:
- `packages/opencode/src/util/error.ts`（扩展，加 5 层错误类）
- `packages/opencode/src/util/result.ts`（新）
- `packages/opencode/src/util/retry.ts`（新）
- `packages/app/src/components/error-toast.tsx`（新）

---

## P1 优先级（参考 ECC 概念，自己设计）

### v0.3.17 — Continuous Learning v2（主人 MEMORY.md 的工程化版本）

**来源**: ECC `skills/continuous-learning-v2/SKILL.md` 概念

**目标**: 把主人当前的"被纠正时写 memory/YYMMDD.md"机制工程化

**ECC 给的核心概念**（要适配的不是直接复制）:
- Atomic "instincts"（带 confidence scoring 的小行为单元）
- PreToolUse/PostToolUse 观察（100% 可靠，比 Stop hook 好）
- 项目级隔离（React 模式留在 React 项目，Python 模式留在 Python）
- 演化路径：instinct → 聚类 → skill/command/agent

**与主人现状的差异**:
- 主人现在用 `MEMORY.md`（人写，AI 读）
- ECC v2 用 `instincts`（AI 写，AI 读）
- **建议**：保留人写的 `MEMORY.md`（主人习惯），**叠加** AI 写的 instincts（自动学习）

**实现方向**:

1. **Instinct Store**（AI 自动）
   - `packages/opencode/.opencode/instincts/` 目录
   - 每条 instinct 一个 YAML 文件（id/trigger/confidence/domain/source/scope）
   - 主人被纠正时 AI 自动写一条

2. **MEMORY.md 保留**（人手动）
   - 继续主人现有的"长篇教训"风格
   - 让 AI 在写 instinct 后，问"要不要也记到 MEMORY.md"

3. **项目级 vs 全局**
   - RedCode 项目的 instinct 留在 RedCode
   - 跨项目的 instinct 提升到 `~/.config/redcode/instincts/`

4. **演化**（主人命令时）
   - `/instinct-cluster`：把相关 instinct 聚成 skill
   - `/instinct-promote`：从项目提升到全局

**涉及文件**:
- `packages/opencode/.opencode/instincts/.gitkeep`（新目录）
- `packages/opencode/.opencode/commands/instinct-cluster.md`（新）
- `packages/opencode/.opencode/commands/instinct-promote.md`（新）
- 配合主人的 `MEMORY.md` 流程

**风险**: 可能和主人手写 MEMORY.md 重复，需要主人体验后决定是否保留

---

## 已废弃（v0.3.14-v0.3.18 旧版本计划）

> 260603 Red 昨天基于错误理解写的规划，已废弃。**不应再按这些做**。

- ~~v0.3.14 上下文压力检测（Counter hooks 模式）~~ → 合并到 v0.3.15
- ~~v0.3.16 Tool Registry 重构~~ → ECC 没这个能力，**RedCode 自己设计**（推迟）
- ~~v0.3.17 Prefetch 空闲调度~~ → ECC 没这个能力，**RedCode 自己设计**（推迟）
- ~~v0.3.18 会话压缩策略~~ → 升级为 v0.3.15

---

## 待主人决定

1. **是否引入 ECC plugin 全文**（v0.3.14）？
   - 优点：立即获得 ECC 全部能力（hooks/tools/agents/commands）
   - 缺点：~3000+ 行代码，主人要 review 决定

2. **ECC 汉化策略**？
   - 完全汉化（prompt + log + 命令）→ 主人用得舒服
   - 仅 log 汉化（prompt 保持英文）→ 跟 ECC 上游同步
   - 不汉化（纯英文）→ 最少维护

3. **ECC agents 是否引入**？
   - planner/architect/code-reviewer/tdd-guide 等 12 个
   - 主人已经手动实现了 v0.3.12 的右键粘贴/侧边栏等（不是 agent 完成）
   - 引入会让 OpenCode 启动变慢（agent 多）

---

## 参考资源

- ECC 项目：`D:\AI\ECC`
- ECC OpenCode plugin：`D:\AI\ECC\.opencode\`（**真材实料**）
- ECC hooks 主文件：`D:\AI\ECC\.opencode\plugins\ecc-hooks.ts`（520 行）
- ECC tools：`D:\AI\ECC\.opencode\tools/*.ts`（8 个）
- ECC 关键 skills：
  - `D:\AI\ECC\skills\error-handling\SKILL.md`（直接可用 TS 错误处理代码）
  - `D:\AI\ECC\skills\strategic-compact\SKILL.md`（压缩决策表）
  - `D:\AI\ECC\skills\continuous-learning-v2\SKILL.md`（AI 学习系统概念）
  - `D:\AI\ECC\skills\hookify-rules\SKILL.md`（YAML hook 规则）
- jCodeMunch 文档：`https://github.com/colbymchenry/jcodemunch`
- TypeGraph 文档：`https://github.com/guyowen/typegraph-mcp`
