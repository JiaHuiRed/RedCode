# RedCode Harness 优化任务书 · 落地审计

日期：2026-11-09
范围：`RedCode Harness 优化实施任务书` 的 RC-01 ~ RC-08，按本地实际代码核对（不是按公开 dev 分支推断）。
方法：逐项读实现、跑对应检查、记录证据；没有执行过的检查一律标 `not_run`，不写成通过。

## 状态总表

| ID | 任务 | 本地状态 | 证据 | 缺口 |
|---|---|---|---|---|
| RC-01 | 指令路径边界 + 远程流式限额 | 已完成 | `76b267cd`；`session/instruction.ts`；`test/session/instruction.test.ts` 14 条 | 无 |
| RC-02 | 端到端 Coding Agent Eval | 未实现 | 全仓无 eval 任务集/运行器 | 整套 |
| RC-03 | 后台子代理并发/排队/预算 | 未实现 | `background/job.ts` 的 `Status` 只有 `running/completed/error/cancelled`，无 `queued`，无 Scheduler | 并发上限、排队、预算 |
| RC-04 | `redcode doctor` | 部分实现 | `cli/cmd/doctor.ts`（445 行）：`--json`、`--prefix`、脱敏、非零退出码、retired key/provider/plugin/MCP 静态检查；`test/cli/doctor.test.ts` 2 条（Soul 配置） | 缺 `--probe`；`--json` 等输出形状无测试 |
| RC-05 | 收尾自动验证与交付报告 | 已完成 | `da1b5513`；`session/verification.ts`；`test/session/verification.test.ts` 12 条 + `prompt.test.ts` 端到端 1 条 | v1 不覆盖 `bash` 改文件；`protected_paths` 是前缀匹配 |
| RC-06 | 记忆双写一致性 | 部分实现 | `seed/scripts/check-memory-dualwrite.mjs`（只读核对索引行 ↔ db 正文） | 无统一写入服务、无事务、无 reconcile、无迁移方案 |
| RC-07 | 分层 CI / 发布门禁 | 已存在 | `.github/workflows/{test,typecheck,e2e,nightly}.yml`；`packages/opencode` 的 `test:smoke` / `test:ci` | Release Gate 未单列（`nightly` 之外没有发布前关键路径集） |
| RC-08 | OS 级隔离执行 | 未实现 | `docs/` 无 sandbox RFC，无 PoC | 整套（RFC + opt-in PoC） |

## 已完成项细节

### RC-01（提交 `76b267cd`）

- 根因：`Instruction.resolve()` 用字符串前缀 `startsWith(root)` 判断「位于项目内」，同前缀兄弟目录（`RedCode-backup`）与 junction 都能越界注入。
- 方案：抽出可单测的 `isWithinRoot(root, candidate)`（`path.relative` 语义 + realpath 二次判定，realpath 失败退回逻辑路径）；远程指令改 `res.stream` 逐块累计，超 `instruction_budget.max_source_bytes` 立即停读并整份丢弃，`Content-Length` 只做提前拒绝。
- 可证伪证据：改回 `startsWith` → sibling/link 两例失败；改回 `arrayBuffer` → chunked 用例 3.56s 失败（阈值 1.5s）；去掉 `Content-Length` 提前拒绝 → 该例 5.43s 失败（阈值 1s）。恢复后 typecheck 0，套件 41 pass / 1 todo。

### RC-05（提交 `da1b5513`）

- 根因：Agent 常在没有验证证据时宣布完成；仓库有快照/diff，但没把「改了什么 → 该跑什么 → 结果」接成证据链。
- 方案：`SessionVerification` 服务 + `runLoopImpl` 收尾钩子。改动来源 = 本轮 `patch` part ∪ `edit`/`write` 工具入参（绝对路径归一化为 worktree 相对路径去重）；只自动选受影响包的 `typecheck`，其余用 `verification.commands` 显式声明；每条命令走 `Permission.ask`，`AppProcess.run` 显式超时会话级 120s、输出 32KB 上限；报告作为可见 text part 落库，结构化结果在 `metadata.verification`，正文 4KB 字节硬上限。
- 状态语义：`passed` / `failed` / `partial`（全部跳过）/ `not_run`（无可跑项，必写原因），不把跳过汇总成通过。
- 验证：opencode typecheck 0；verification 12 pass；prompt 110 pass / 12 skip；端到端用例经真实 `write` 工具改文件后报告 `changed_files: ["src/a.ts"]` 且 `passed`；OpenAPI drift 一致。

## 部分实现项

### RC-04 `redcode doctor`

本地已有实现，覆盖了任务书要求的「本地静态诊断 + 脱敏 JSON + 失败退出码」主体：

- `cli/cmd/doctor.ts`：`retiredCheck` 扫已废弃配置键；provider/model 统计（enabled/disabled、模型数）；plugin / MCP 检查；`--json` 输出；`--prefix` 指定工作区。
- 脱敏：provider `options.apiKey` 按掩码输出（`doctor.ts` 内 `mask` 逻辑）。
- 单测：`test/cli/doctor.test.ts` 已有 2 条（Soul registry 告警、Soul 来源预算），尚未覆盖 `--json` 输出与顶层/嵌套未知键。
- 未覆盖：`--probe`（真实模型/MCP 连通性探测）。
- 结论：RC-04 的「基础版本」已满足任务书验收的一半；补 `--probe` 与输出形状测试即可收口。

### RC-06 记忆双写

- 已有 `seed/scripts/check-memory-dualwrite.mjs`：只读打开 `supermemory.db`，核对 `MEMORY.md` 的 `#NN` 索引行与库内正文是否一一对应，作为安全带第一档。
- 未做：统一写入服务、事务提交、索引重建、`reconcile`、旧格式迁移与回滚。任务书要求的「异常退出后可恢复」当前只能靠备份脚本（`export-memory-backup.mjs`）。

### RC-07 CI

- 已存在分层：`test.yml`、`typecheck.yml`、`e2e.yml` 作为 push/PR 快闸，`nightly.yml` 跑全量；对应脚本 `test:smoke`、`test:ci`。
- 未单列 Release Gate：没有「发布前关键路径集」这一层，发布前只能人工指定跑 `test:ci` 或 nightly。

## 未实现项

- **RC-02 Eval**：无离线任务集、无运行器、无结果 schema。RC-05 已能提供 `verification_status` 与 `changed_files`，可直接作为 Eval 的度量来源。
- **RC-03 调度**：`BackgroundJob.start()` 仍是 `forkIn(..., { startImmediately: true })`，取消树/持久化已有，但启动前没有全局/父会话/Provider 维度的配额。
- **RC-08 隔离**：无 RFC、无 PoC。`SECURITY.md` 的权限模型仍是用户确认体验，不是 OS 沙箱。

## not_run（本次审计未执行）

- 全量 `bun test`（4500+ 用例）与 `test:ci`：耗时与内存预算不允许，且本次只审计既有实现。
- 真实模型 Eval / 成本数据：无任务集，均 `not_measured`。
- Windows runner 上的 CI 实际耗时：未触发远端 workflow。

## 建议顺序

1. **RC-04 收口**（低成本、用户可感知）：补 `--probe`（显式 opt-in、限次、费用提示）与 doctor 测试。
2. **RC-02 离线 Eval**：先 5~8 个 fixture，复用 RC-05 的报告口径做 `verification_status`。
3. **RC-03 并发上限**：先做全局 + 父会话两级信号量，`queued` 状态与 UI 呈现随后。
4. **RC-06 写入服务化**、**RC-07 Release Gate**、**RC-08 RFC** 按批次推进。

## 兼容性说明

RC-01 / RC-05 都不改公共协议形状：RC-01 只改内部判定与读取方式；RC-05 复用既有 text part + metadata，配置块为可选项。旧配置、旧会话、TUI/GUI 与 Windows 路径均未受影响（对应测试已覆盖带空格路径与 junction）。
