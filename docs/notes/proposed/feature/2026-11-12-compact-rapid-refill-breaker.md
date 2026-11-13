# 自动压缩的快速回填熔断（rapid-refill breaker）

状态:proposed

## 问题

RedCode 的自动压缩已有两道成本保护：`prompt.ts` 的 prune 先行（`PRUNE_SKIP_MIN_RATIO =
0.15`，释放不够就落到真压缩）与 `compaction.ts` 的 native shortfall 日志。但**没有
「压缩后很快又被填满」的连续计数**：只要模型继续干活、上下文再次越过触发线，就会再压一次。
每次真压缩都是一次付费模型调用 + 前缀缓存重建；压缩后几轮内重新回填意味着这次钱基本白花，
且下一次压缩会以同样的方式再付一遍。

对照 ZCode 的处理（`E:\AI\ZCode\docs\conversation-session-case-catalog.md:857` RC04 +
`E:\AI\ZCode\apps\zcode-cli\packages\core\src\compact\policy.ts`）：连续两次在**不足 3 个
完整 tool turn** 内重新达到 auto threshold，第 3 次在启动压缩前熔断，返回
`model_context_exceeded`（reason `compact_rapid_refill_breaker`），不新增 compact
boundary / failed marker。它的取舍是：宁可显式失败，也不无限付费压缩。

RedCode 的触发链：`session/processor.ts:1056-1061`（usage 后 `isOverflow` →
`needsCompaction`）→ `session/prompt.ts:2578-2634`（`result === "compact"` 调
`compaction.create({ auto: true })`）→ `session/compaction.ts:732`
（`processCompactionInner` 入口）。

## 决策

在 `SessionCompaction` 内增加 per-session 的快速回填追踪（进程内 Map，重启清零）：

- 每次 **auto** 压缩成功（`Event.Compacted` 发布点，legacy `compaction.ts:1057` 与
  native `compaction.ts:690`）记录 `{ lastMessageID, atMs, streak }`。
- 下一次 auto 压缩进入 `processCompactionInner` 时，统计 `lastMessageID` 之后完成的
  assistant tool turn 数（assistant 消息含 `state.status === "completed"` 的 tool part）：
  - `< 3` → `streak += 1`
  - `>= 3` → `streak = 1`
- `streak >= 3`（即第 3 次快速回填）→ 熔断：不发模型请求、不写 compaction
  boundary，发布 `ContextOverflowError`（message 写明 `compact_rapid_refill_breaker`）与
  warn 日志，并写一条 **failed summary**（`summary: true` + `error` + `time.completed`）
  把 pending compaction task 标成失败；`process` 返回 `"stop"`。
  failed summary 是 `MessageV2.latest` 的 `failedCompactions` 既有约定：没有它，旧 task
  会在之后每个用户轮被 `tasks.pop()` 重新命中、再次熔断，用户消息永远到不了模型（换模型
  也无效，261113 真实 `SessionPrompt.loop` 回归）。
- 手动压缩（`auto === false`）不参与追踪，也不被熔断。

阈值先按 ZCode 的经验值（3 turns / 3 次），常量集中放在 `compaction.ts` 顶部，便于观察后
调整。

## 备选与否决理由

- **只告警不熔断**：否决——告警不能在付费调用发生前拦住它，等于继续烧钱。
- **持久化追踪状态**：否决——进程重启后重新计数即可；ZCode 的实现同样是 runtime 内存，
  持久化会引入与 compact boundary 的额外一致性问题。
- **把熔断放在 `create`**：否决——`create` 只写 compaction marker，不产生模型调用；
  真正付费的是 `process`，熔断必须在模型请求之前、marker 创建之后仍然可见的位置。

## 后果

- 极端情况下会话会在第 3 次快速回填时明确失败，而不是无限压缩；用户需要主动清理上下文
  或换模型。失败原因必须可见（日志 + bus 事件），不能静默卡住。熔断请求本身失败，但
  pending task 会被 failed summary 退休：下一次用户消息不再被旧 task 阻塞，模型切换也能
  真正生效（上下文仍超限时由 provider 显式报错）。
- `streak` 统计依赖「完成 tool turn」的判定；如果某轮工具调用全部失败，turn 数为 0，
  会更快触发熔断——这是有意的保守方向。
- 需要真机观察阈值是否误杀正常的长任务（每轮工具调用密集、上下文本来就大的会话）。
- 决策记录回链：立项来自 ZCode v3.15.1 吸收调研（2026-11-12），实现后本 note 移入
  `implemented/feature/` 并更新状态。

## 实现记录（2026-11-12）

- `session/compaction.ts` 顶部：`RAPID_REFILL_TURNS = 3`、`RAPID_REFILL_LIMIT = 3`、
  进程内 `rapidRefill` Map、`countCompletedToolTurnsAfter()` 与 `rapidRefillDecision()`
  纯函数。
- `processCompactionInner` 入口（parent 校验之后、`setCompacting` 之前）检查 auto 压缩；
  熔断时发布 `ContextOverflowError`（含 `compact_rapid_refill_breaker`）与 warn 日志，
  返回 `"stop"`，不写 compaction marker。
- native（`processNative` 成功点）与 legacy（`processCompactionInner` 成功点）两处
  `Event.Compacted` 前调用 `noteRapidRefillSuccess()`。
- 验证：`test/session/compaction.test.ts` 新增 4 条纯函数用例（turn 计数、边界缺失、
  第 3 次熔断、足量 turn 重置），全套 91 pass / 0 fail；`bun run typecheck` exit 0；
  `bun run test:smoke` exit 0。
- 状态仍为 proposed：真机长会话上的阈值误杀情况尚未观察。

### 261113 修复：熔断死锁与状态推进

- 熔断时补写 failed summary（`summary: true`、`error`、`time.completed`、
 `finish: "error"`），复用 `MessageV2.latest` 的 `failedCompactions` 约定退休 pending
 compaction task；不写 boundary/tail、不发 `Event.Compacted`，也不会被
 `filterCompacted` / `completedCompactions`（都要求 finish 且无 error）当成压缩成功。
 之前只发事件就 `return "stop"`，旧 task 留在消息里，真实 `SessionPrompt.loop` 会在
 每个后续用户轮先 `tasks.pop()` 到它，再次熔断并不进入模型步。
- streak 改为只在压缩**成功**点写入（入口只读决策）：失败/中断不再累加，否则连续失败会
 被误判成连续快速回填；手动压缩完全不读写追踪状态（原实现会把手动压缩的边界写进去）。
- turn 计数改按 `MessageV2.compareTime` 判时序（与 `latest` 同口径）：legacy 可见历史
 `filterCompactedOrdered` 会把保留的 tail 排到压缩边界之后，按数组下标数会把旧轮次算成
 压缩后的新工作，默认 2 个 tail 加 1 个新轮就够 3，熔断实际永不触发。
- 验证：`test/session/compaction.test.ts` 保留纯函数用例，新增真实 `SessionCompaction`
 用例（成功→失败→再尝试、手动压缩夹在自动压缩间、熔断退休 task）与真实
 `SessionPrompt.loop` 用例（熔断后下一条用户消息能真实请求模型）。定向：
 `bun test test/session/compaction.test.ts --timeout 30000 -t "breaker trips"`。
