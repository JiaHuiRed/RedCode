# 七个 commit 复查：事实与数字全部对得上，一处分支语义比声明宽（已按方案 a 收紧）

状态:implemented

## 问题

2026-10-14 本地提交 7 个 commit，覆盖 execute 提示词收敛、子代理定向纠偏、未完成响应记账、忙时压缩续跑、TUI 压缩分割线、流静默超时重试、CHANGELOG 记录。本文件是对这 7 个 commit 及其随附 note/CHANGELOG 的独立复查记录：核对**声称的事实**（字符数、测试数、行为语义）与**代码实际**是否一致。

复查对象：

| commit | 主题 | 随附 note |
| --- | --- | --- |
| `00762296` | execute 子代理决策收敛 | `implemented/feature/2026-10-14-execute-prompt-convergence.md` |
| `7652cdac` | 子代理定向纠偏 | `implemented/feature/2026-10-14-subagent-steering.md` |
| `b6fcc529` | 未完成响应记账 | `implemented/bug-fix/2026-10-14-incomplete-response-accounting.md` |
| `b388ed17` | 忙时压缩后接续原任务 | `implemented/feature/2026-10-10-native-compaction.md#忙时手动压缩后的续跑` |
| `e58633ed` | TUI 压缩分割线用实报上下文 | `implemented/bug-fix/2026-10-14-compaction-context-usage.md` |
| `117cfeda` | 流静默超时重试 | `implemented/bug-fix/2026-10-14-stream-idle-timeout-retry.md` |
| `488f6309` | CHANGELOG Unreleased 6 条 | —— |

## 复查口径

四条，逐条对照代码、note、CHANGELOG 与实跑：

1. **事实准确性** —— message/note/CHANGELOG 里的数字、行为描述与代码是否一致。
2. **测试宣称** —— CHANGELOG 里写的 pass 数与 expects 数，实跑是否复现。
3. **模型可见面** —— CHANGELOG 的四问声明（提示词/schema/缓存/注入）与改动面是否吻合。
4. **数据面可验证性** —— 声称"已修"的分支，在真实库里有没有可观测的触发面。

## 逐 commit 核实

### `00762296` execute 决策收敛 —— 一致

- 代码：`agent/definition/execute.md` EOF 追加 `## 决策收敛` 4 条，之前前缀零改动。
- 数字：实测 `before 4826 bytes / 2776 chars` → `after 5397 bytes / 2987 chars`，**增量 571 bytes / 211 chars**，与 CHANGELOG「+211 字符、571 UTF-8 bytes」逐字吻合。
- 测试：`agent.test.ts` 新增 3 条 `toContain` 断言，落在既有 frontmatter 用例内。
- 四问：① 仅 execute system prompt 新增四段，其余 agent/schema/参数未动；② 增量即上述 571 bytes；③ 新段在 EOF，原前缀不变；④ 静态文本，无动态注入。与声明一致。

### `7652cdac` 子代理定向纠偏 —— 一致

- 代码：`task.ts` 新增 `runSteerableTask()`（模块级 `steering` Map + `Effect.acquireUseRelease`）与 `steerTask()`；`task_status.ts` 新增 `message` 分支；`task_status.md` 补两段说明。
- 边界逐项核对，均与声明一致：仅直接父会话（`child.parentID !== ctx.sessionID` 拒绝）、目标须 running（`job?.type !== "task" || job.status !== "running"`）、`message` 与 `wait`/`timeout_ms`/`cancel` 互斥、`> 16_384` UTF-8 bytes 拒绝。
- 收尾竞态：use 分支先 `steering.delete` 关准入，再 `Fiber.join` 已接受投递。`steerTask` 内 `steering.get` 与 `pending.push` 之间无 `await`，与 use 分支的 `delete` 不构成交错窗口——「先关准入再等待已接受投递」成立。
- 回执：以持久化消息 `delivery` 为准，`delivered` 才报 `delivered`，否则 `queued`，不谎报已消费。与声明一致。

### `b6fcc529` 未完成响应记账 —— 一致，含两处已声明范围

- 代码：native 侧 `onResponseFinish` 在 `response.incomplete && !hasFunctionCall && classify === "terminal"` 时追加 `provider-error`；`classifyResponsesIncomplete` 仅 `interrupted` 判 `continuable`，其余 `terminal`；`boundedIncompleteReason` 64 字符封顶 + `/^[a-z0-9_-]+$/i` 白名单，异形折叠 `unspecified`；ai-sdk 侧 `rawFinishReason` 命中 `max_output_tokens`/`content_filter` 时置 `terminalIncomplete`，`finish` 后追加 `provider-error`。
- 双重记账：`estimatedFinishEvents` 加 `if (state.sawStepFinish) return []`；`start-step` 重置 `sawStepFinish`/`terminalIncomplete`。与声明一致。
- **观察点 1**：`hasFunctionCall` 是「整个响应至今发过 tool-call」，不是「被截断时工具未完成」。若模型先发一个已完成的 tool-call、随后正文被 `max_output_tokens` 截断，本分支不补 `provider-error`（工具循环会继续，最终轮若无 tool-call 再截断才会报）。方向保守，但语义比字面宽。
- **观察点 2**：两条 runtime 对「未知 reason」判定范围不同——native 除 `interrupted` 全按终态，ai-sdk 只认两个字面量。ai-sdk 注释已声明原因（接缝拿不到「这是 Responses API」标记），属已声明限制，非遗漏。

### `b388ed17` 忙时压缩续跑 —— **唯一实质偏差，见下节**

### `e58633ed` TUI 压缩分割线 —— 一致，含一处口径细节

- 代码：`compactionContext` memo 改取 `contextSource(...)?.tokens.context`（压前最近主请求）与压缩 marker 后首个主请求 `tokens.context`；`superseded` 在被后续 marker 覆盖时不伪造压后值；旧 `tokens_before/tokens_after` 估算字段不再展示。
- **口径细节**：压后首个主请求的筛选是 `!summary && tokens.output > 0 && tokens.context !== undefined`。数据面全库 33 条 `tokens.output === 0` 且有 `context` 的非摘要主请求中，9 条 `context > 0`——会被 `output > 0` 跳过。CHANGELOG 措辞是「跳过零用量占位」，实现判的是 `output > 0` 而非「零用量（output 与 context 皆 0）」。跳过后仍会取到更后面的请求，实际影响有限，但措辞与判据不完全对应。

### `117cfeda` 流静默超时重试 —— 一致

- 代码：`retryable(error: unknown, provider)` 放宽入参类型，先读原始 `_tag`（`FirstEventTimeoutError` / `StreamIdleTimeoutError`）再走归一化 `APIError` 判定；`policy` 改为 `retryable(meta.input, ...) ?? retryable(parsed, ...)`，`delay` 仍按归一化结果取 headers。
- 策略不变：`RETRY_MAX_ATTEMPTS`、`delay` 退避与可见终态未动。与声明一致。

### `488f6309` CHANGELOG —— 覆盖完整

6 条 Unreleased 逐条对应 6 个代码 commit，第 7 个 commit 即 CHANGELOG 自身，无遗漏、无虚构条目。note 路径全部指向 `implemented/`，与实际落盘路径一致（已用 `git show --name-only` 核对）。

## 测试复跑

CHANGELOG 的 pass 数逐项复现：

| 文件 | 宣称 | 实测 |
| --- | --- | --- |
| `agent.test.ts` | 53 pass / 242 expects | **53 pass / 0 fail / 242 expects** |
| `task_status.test.ts` | 8 pass | **8 pass / 0 fail** |
| `retry.test.ts` | 33 pass | **33 pass / 0 fail** |
| `compaction.test.ts` | 76 pass | 76 pass / 0 fail（前次已核） |
| `compaction-fold.test.tsx` | 14 pass | 14 pass（前次已核） |
| `packages/llm` `openai-responses.test.ts` | 54 pass | 54 pass / 0 fail（前次已核） |
| opencode `llm.test.ts` + `llm-native.test.ts` | 49 pass | 49 pass（前次已核） |

## 已排除的两处失败簇（与本次 7 个 commit 无因果）

- `compaction` 组 2 fail（`stops quickly when aborted during retry backoff` + 一个 hook timeout）：A/B 回退 `retry.ts`（pre-`117cfeda`）与 `compaction.ts`（pre-`b388ed17`）后**仍 fail**。
- `prompt.test.ts` 2 fail（`cancel with queued callers resolves all cleanly`、`prompt submitted during an active run is included in the next LLM input`，均 3000ms 超时）：A/B 回退 4 个被改源码（`retry.ts`/`compaction.ts`/`llm.ts`/`ai-sdk.ts`）后**仍 fail**；`git log -S` 确认两用例由 `d6d579c4`（初始状态）引入。

两簇均非本次 7 个 commit 引起，属既有问题，另行处置。

## 唯一实质偏差：`hasUnfinishedTurn()` 的 `stop` 分支

`packages/opencode/src/session/compaction.ts:1037-1038`：

```ts
return assistant.finish === "stop" && visible.find((message) => message.info.id === assistant.id)
  ?.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted) === true
```

**声明**：CHANGELOG 第 6 条写「已完成/报错的原轮与空闲会话……保持不凭空开工」，note `native-compaction.md:215` 写「已完成或报错的原轮不凭空开工」，同段把该分支描述为「**stop 带待回传工具**」。

**实现**：判据只有 `part.type === "tool" && !part.metadata?.providerExecuted`，**不检查 `part.state.status`**。即「stop 且含任意本地工具记录」——不论该工具是 `completed`、`failed` 还是 `pending`——一律返回 `true`（视为未完成）。

**实测（探针，已 revert）**：构造 `finish: "stop"` + 一条 `type: "tool"` / `tool: "bash"` / `state.status: "completed"` / 无 `metadata.providerExecuted` 的 assistant 消息，跑 `SessionCompaction.process`：

```
SCRATCH-RESULT legacy process= continue followups= 1
SCRATCH-RESULT native process= continue followups= 1
0 pass  2 fail
```

预期 `followups === 0`（已完成的轮次应保持空闲）被推翻——native 与 legacy 都续跑。与「待回传」措辞不符：一个**已回传完成**的本地工具同样触发续跑。

**数据面**：全库 5915 条 `finish=stop` 非摘要 assistant 中，**0 条**含本地 tool part。原因是含 tool part 的 assistant 消息其 `finish` 必为 `tool-calls`，`stop` 与 tool part 天然不同现。故 `1037-1038` 行在正常数据流下**不可达**——本次偏差**当前无线上可观测影响**，属纸面分支。

**测试缺口**：`b388ed17` 新增的 4 条用例（native/legacy × unfinished）只覆盖 `finish: "tool-calls"`（→ 续跑）与 `finish: "stop"` 且**无工具**（→ 空闲），未覆盖 `finish === "stop"` + 本地 tool part 这条真值分支，故「先红后绿」未触及它。

## 结论与处置

7 个 commit 的 message / note / CHANGELOG 与代码**基本一致**：字符数、测试数、行为描述全部核实，无虚构数字；6 条 CHANGELOG 覆盖完整；模型可见四问与改动面吻合。两处失败簇已排除因果。

`hasUnfinishedTurn()` 的 `stop` 分支取**方案 (a) 收紧实现**（哥哥 261014 拍板）：文字描述的是更精确的意图，且顺带补上测试缺口。已落地：

- `compaction.ts` 判据加 `state.status`：只有 `pending`/`running`（工具结果未回传）的本地工具算未完成，`completed`/`error` 不算。
- `compaction.test.ts` 补 `finish=stop` × {`completed`, `running`} × {native, legacy} 四条用例：completed 不续跑、running 续跑。**先红后绿已验证**——换回旧判据后两条 completed 用例 `followups` 实得 1（期望 0）失败，两条 running 用例两种判据下均通过。
- 该文件随本次修复从 `proposed/` 移入 `implemented/`；CHANGELOG/note 的「待回传工具」措辞不动，代码向文字对齐。

另有两处**口径细节**（非缺陷，已登记，不单独动手）：

- `b6fcc529` 的 `hasFunctionCall` 是「发过 tool-call」而非「截断时工具未完」。
- `e58633ed` 的压后主请求筛选用 `output > 0`，会跳过 9 条 `output=0 但 context>0` 的真实实报请求（全库 33 条中）。

## 后果

- 改动面：`compaction.ts` 一处判据 + 测试四条用例 + note/CHANGELOG。模型可见面零增量（`hasUnfinishedTurn` 不产生模型输入，只决定是否补发既有 `compaction_continue` 通知）；`compaction.test.ts` 80 pass / 0 fail。
- 识别签名：`hasUnfinishedTurn` 的 `stop` 分支只在「`finish=stop` 且该 assistant 消息含 `pending`/`running` 本地工具」时触发；正常数据流下该组合为 0，一旦线上出现说明有 provider 把工具轮误报成 `stop`，此时会续跑一轮（这是有意的防御行为）。
- 复查阶段未改源码；落地阶段的改动全部集中在上述文件，工作树另有一份未跟踪的 `2026-10-14-native-history-reference-echo.md`（native 标记复述的诊断，与本修复无关）。
