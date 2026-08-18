---
name: ce-code-review
description: 结构化代码审查。用户说"帮我看看代码""review一下""审一下""看看这个PR"时触发。多维度人格审查、severity 门控、merge/dedup。
---

# ce-code-review

> 结构化代码审查：分层人格审查、confidence-gated findings、merge/dedup pipeline。

`ce-code-review` 是**深度代码审查** skill。分析 diff（PR、分支或当前变更），根据实际触及的内容选择合适的审查人格，顺序执行审查，将结果 merge/dedup 为一份统一报告。每个 finding 携带 severity（P0-P3）、autofix class（`gated_auto`/`manual`/`advisory`）和 owner。

---

## TL;DR

| 问题 | 答案 |
|------|------|
| 做什么 | 根据 diff 内容选择审查人格，顺序审查，合并去重为一份报告，含 confidence 门控和 autofix 路由 |
| 什么时候用 | 打开 PR 前的深度审查；安全/支付/迁移等敏感变更；明确要求 thorough review |
| 产出物 | 结构化 findings 报告；交互模式下还会应用安全修复并提交 `fix(review):` commit |
| 模式 | 交互模式（默认，应用安全修复）/ `mode:agent`（仅报告，调用方应用） |

---

## 问题

通用代码审查提示词会以可预测的方式崩塌：

- **表面发现** — "建议加测试"但不说测什么
- **与 diff 无关** — 文档改动给安全反馈，typo 修复给性能反馈
- **无 severity 校准** — 每个 finding 都标 critical，真正的 P0 被淹没
- **无 confidence 校准** — "可能是 bug"和已验证缺陷同等呈现
- **单次推理** — 单一审查者偏向其训练数据最重的部分
- **无结构化跟进** — findings 留在聊天里，无记录、无修复队列

## 解决方案

`ce-code-review` 作为结构化 pipeline 运行，有明确门控：

- **Diff 感知人格选择** — 4 个 always-on 审查者 + 2 个 CE always-on agent，加 cross-cutting 和 stack-specific 人格
- **顺序人格执行** — 每个审查者聚焦其视角；结果顺序返回
- **Confidence-gated synthesis** — findings 合并、去重、跨人格共识提升优先级、按 autofix class 路由
- **Severity（P0-P3）+ autofix class** — 紧急度与行动所有权正交
- **两种模式** — 交互模式（默认，应用安全修复）/ `mode:agent`（JSON，仅报告）
- **Quick-review 短路** — 轻量审查直接跳过，只在需要时运行完整 pipeline

---

## 核心概念

### 1. Diff 感知人格选择

小配置改动触发 6 个审查者。Rails auth feature + migration 可能触发 10 个。技能根据 diff 内容决定哪些人格适用：

**Always-on（每次审查）**：
- `ce-correctness-reviewer` — 正确性：逻辑错误、边界情况、错误处理
- `ce-testing-reviewer` — 测试覆盖：缺失测试、断言质量、边界覆盖
- `ce-maintainability-reviewer` — 可维护性：复杂度、命名、结构
- `ce-project-standards-reviewer` — 项目规范：代码风格、约定、模式一致性
- `ce-agent-native-reviewer` — AI 生成代码特征：过度抽象、防御性过度、模板化模式
- `ce-learnings-researcher` — 历史教训：从 `docs/solutions/` 和项目记忆中检索相关经验

**Cross-cutting conditional（按需触发）**：
- `ce-security-reviewer` — 安全：auth、crypto、注入、权限提升
- `ce-performance-reviewer` — 性能：N+1 查询、内存泄漏、算法复杂度
- `ce-api-contract-reviewer` — API 契约：向后兼容、breaking changes、类型一致性
- `ce-data-migration-reviewer` — 数据迁移：schema 变更、数据完整性、回滚安全
- `ce-reliability-reviewer` — 可靠性：错误处理、重试逻辑、幂等性
- `ce-adversarial-reviewer` — 对抗性：用户输入验证、边界注入、权限绕过
- `ce-previous-comments-reviewer` — 历史评论：关联 PR/issue 的先前审查意见

**Stack-specific conditional**：
- 前端竞态、Swift/iOS 特定模式 — 仅在触及对应运行时时触发

人格选择基于 agent 判断，非关键词匹配。指令性文件（Markdown skills、JSON schemas）跳过运行时人格（adversarial、races）。

### 2. Severity（P0-P3）与 autofix class 正交

| Severity | 含义 | 示例 |
|----------|------|------|
| **P0** | 关键断裂：安全漏洞、数据丢失、生产崩溃 | SQL 注入、密码明文存储 |
| **P1** | 重大问题：功能错误、显著性能退化 | 逻辑分支遗漏、N+1 查询 |
| **P2** | 一般问题：代码质量、可维护性、次要功能缺陷 | 过深嵌套、缺少错误处理 |
| **P3** | 建议：风格偏好、轻微改进 | 命名建议、注释补充 |

Autofix class 是关于**后续形态**的信号（非应用权限）：

| Class | 含义 |
|-------|------|
| `gated_auto` | 有具体 `suggested_fix`，是应用的候选 |
| `manual` | 需要设计输入或手动交接的可操作工作 |
| `advisory` | 仅报告（学习笔记、发布说明、残留风险） |

Synthesis 拥有最终路由权。人格提供的路由元数据是输入，不是最终裁决——分歧默认走更保守的路由。

### 3. 两种模式

| 模式 | 场景 | 行为 |
|------|------|------|
| **交互模式**（默认） | 直接用户调用 | Markdown 报告；审查应用安全、已验证的修复，提交为孤立的 `fix(review):` commit（tree 干净时）或留给你的 commit（tree 脏时）。永不 push |
| **`mode:agent`** | 程序化调用 | 一个 JSON 对象；仅报告——审查不修改任何东西，调用方应用 findings |

### 4. Confidence-gated synthesis pipeline

所有人格返回后，synthesis：

1. **Schema 验证** — 每个 finding 符合标准格式
2. **Diff 锚定** — 丢弃关于不存在行或不在范围内行的 findings
3. **跨人格去重** — 多个审查者发现同一问题时合并
4. **跨人格共识提升** — 两个审查者发现同一问题时提升优先级
5. **矛盾解决** — 不同人格对同一问题意见不同时裁决
6. **Tier 路由** — 已应用修复、gated/manual、FYI

输出是一份带校准 severity、证据引用和明确所有权的报告，不是每个审查者原始输出的扁平列表。

---

## 执行流程

### Stage 1: 范围检测

确定审查范围：
- 当前分支 vs `origin/HEAD`（或 PR metadata）
- 指定 PR（`ce-code-review 1234` 或 URL）
- 指定分支（`ce-code-review feat/xxx`）
- 指定 base ref（`ce-code-review base:abc1234`）

```bash
# 获取 diff
git diff origin/HEAD...HEAD --stat
git diff origin/HEAD...HEAD
```

### Stage 2: 意图摘要

读 commit messages，写 2-3 行意图摘要：
- 这组变更要解决什么问题？
- 主要涉及哪些文件/模块？
- 有没有 migration、breaking changes、安全相关变更？

### Stage 3: 人格选择

根据 diff 内容选择适用人格：
- always-on 人格全部启用
- 扫 diff 文件路径，按条件启用 cross-cutting 人格
- 检查语言/框架，启用 stack-specific 人格

### Stage 4: 顺序审查

按人格逐个执行审查。每个人格：
1. 读取 diff 中与其视角相关的文件
2. 产出 findings 数组，每个 finding 包含：
   - `severity`: P0-P3
   - `autofix_class`: gated_auto / manual / advisory
   - `file`: 文件路径
   - `line`: 行号
   - `title`: 一句话描述
   - `evidence`: 证据引用（代码片段）
   - `suggested_fix`（可选）: 具体修复建议
   - `confidence`: 0-100

### Stage 5: Synthesis

1. 收集所有人格的 findings
2. Schema 验证 + diff 锚定
3. 跨人格去重（同文件同行同类型 → 合并）
4. 跨人格共识提升（2+ 审查者发现 → priority 提升）
5. 矛盾解决（保守优先）
6. 按 severity 排序

### Stage 6: 输出

**交互模式**：
- 输出 Markdown 报告
- 对 `gated_auto` 且 confidence ≥ 80 的 finding，询问用户是否应用
- 用户确认后，用 `edit` 应用修复
- 所有修复验证通过后，可选提交 `fix(review):` commit

**`mode:agent`**：
- 输出一个 JSON 对象，调用方处理

---

## 输出格式

### 交互模式（Markdown）

```markdown
# Code Review Report

**Scope**: feat/auth → origin/main (47 files, +1203 -89)
**Intent**: 实现 JWT 认证 + RBAC 权限控制
**Reviewers**: correctness, testing, maintainability, security, reliability (5 active)

## Summary

| Severity | Count |
|----------|-------|
| P0 | 1 |
| P1 | 3 |
| P2 | 5 |
| P3 | 2 |

## Findings

### [P0] SQL Injection in user search
- **File**: `src/api/users.ts:42`
- **Autofix**: gated_auto
- **Confidence**: 95
- **Evidence**: ```ts
  const query = `SELECT * FROM users WHERE name = '${req.query.name}'`;
  ```
- **Suggested Fix**: 使用参数化查询
- **Applied**: ✅ 已修复

### [P1] Missing password hash validation
...

## Applied

3 findings auto-applied and verified:
- `fix(review): parameterize user search query` (src/api/users.ts)
- `fix(review): add bcrypt compare timing` (src/auth/verify.ts)
- `fix(review): remove debug logging` (src/api/middleware.ts)

## Residual

2 findings require manual action:
- [P1] RBAC permission matrix not documented (manual)
- [P2] Rate limiting missing on auth endpoint (advisory)
```

### `mode:agent`（JSON）

```json
{
  "scope": "feat/auth → origin/main",
  "intent": "JWT auth + RBAC",
  "findings": [
    {
      "id": "F001",
      "severity": "P0",
      "autofix_class": "gated_auto",
      "file": "src/api/users.ts",
      "line": 42,
      "title": "SQL Injection in user search",
      "evidence": "const query = `SELECT * FROM users WHERE name = '${req.query.name}'`;",
      "suggested_fix": "Use parameterized query",
      "confidence": 95,
      "reviewers": ["ce-correctness-reviewer", "ce-security-reviewer"]
    }
  ],
  "applied": [],
  "residual": ["F003", "F005"]
}
```

---

## RedCode 工具映射

原 CE skill 引用的工具名在 RedCode 中的对应关系：

| CE 工具名 | RedCode 工具 | 说明 |
|-----------|-------------|------|
| `AskUserQuestion` | `question` | 交互式问答 |
| `Agent` / `Task` | `task` | 子代理调度 |
| `TaskCreate` / `TaskUpdate` / `TaskList` | `todowrite` | 任务跟踪 |
| `ToolSearch` | `skill` | 加载技能 |
| `Bash` | `bash` | Shell 命令 |
| `Read` | `read` | 读文件 |
| `Write` | `write` | 写文件 |
| `Edit` | `edit` | 编辑文件 |
| `Grep` | `grep` | 内容搜索 |
| `Glob` | `glob` | 文件搜索 |

审查执行时使用 RedCode 工具名。

---

## 调用方式

```
/ce-code-review                    # 审查当前分支
/ce-code-review 1234               # 审查指定 PR
/ce-code-review feat/notification  # 审查指定分支
/ce-code-review base:origin/main   # 指定 base ref
```

---

## 修复循环纪律

审查 findings → 修复 → 复审，这个循环有硬约束：

- **Scoped 复审**：复审只看 fix diff（修复前后对比），不重审全量。fix 范围外的新发现记入 Residual/下一轮，不扩展循环
- **轮次上限 3**：R1-R2 同一实现者修；R3 换更强模型（fresh 子代理）；R3 仍有未解决 finding → 全部交用户裁决，没有第 4 轮
- **Controller 不亲自修**：主会话只做协调和裁决。亲自修 = 跳过复审 + 污染上下文；修复交给实现者/子代理
- **Minor 不阻塞**：P3 不进修复循环，记 Residual，交付前 triage
- **修复带证据**：修复报告必须含覆盖测试、跑的命令、输出——没这三样不派复审

---

## Quick-review 短路

用户说 "quick"、"fast"、"light" 时，跳过完整 pipeline，直接用轻量审查（git diff + 常见问题扫描）。`mode:agent` 始终运行完整 pipeline。

---

## 与 defensive-agent 的关系

- `defensive-agent` = 自我治理（FP 过滤、confidence gate、首次编辑调查）
- `ce-code-review` = 代码审查（多维度 findings、severity 校准、autofix 路由）

两者互补：defensive-agent 防止你制造问题，ce-code-review 发现别人（或你自己）制造的问题。

---

## See Also

- `diagnose` — 审查中发现 bug 时的调试流程
- `simplify` — 审查中发现过度工程时的简化流程
- `defensive-agent` — 日常编码的防御性实践
