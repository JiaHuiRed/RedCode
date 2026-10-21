# 中断后迟到事件建出重复 tool-call：DeepSeek 400 Duplicate tool_call_id

状态:implemented

## 问题

`ses_ffe5ea3f9fc6affeVuOAbr0ti96vsW` 在 12:15:42 / 12:16:58 两次请求被 DeepSeek 拒绝：

```
Duplicate value for 'tool_call_id' of call_db39606c325c414292801ae0 in message[51]
```

wire 数组反解（从 `~/.redcode/data/log/2026-10-21T115512.log` 的 `requestBodyValues` 直接解出）：
`message[51]` 是**一条** assistant 消息，`tool_calls` 里同一个 id 出现两次，name 都是 `bash`。

库里对应 `msg_001a15c531131002zJTVrW0me8Yf8u` 有两个 tool part，同 `callID`、不同 part id：

| part | 状态 | start → end |
|---|---|---|
| `prt_001a15c539e7a…`  | error / `Tool execution aborted`、`metadata.interrupted=true` | 10:39:06 → 10:44:08 |
| `prt_001a15c584afb…`  | completed（output 是**第一次执行**的结果，含 20s 超时提示） | 10:44:12 → 10:44:12 |

链路：

1. 工具执行中被中断（abort）。`failToolCall` 把 part 标成 error，随后 `settleToolCall`
   **删掉** `ctx.toolcalls[callID]` 条目（`processor.ts`）。
2. 迟到的同一个 `tool-call` / `tool-input-*` 事件再来时，`readToolCall` 只查内存 → miss；
   `updateToolCall` 里 `known=false` → 走 `adoptOrphanToolCall`，或 `ensureToolCall` 走到新建分支，
   在**同一条** assistant 消息上写第二个 part（AI SDK 对同一 toolCallId 只 execute 一次，
   所以第二条 part 的输出是第一次的结果，12ms 只是写库时间）。
3. 出站转换逐 part 忠实：两个 part → assistant `tool_calls` 里两条同 id 声明 → DeepSeek 400。

`sanitizeToolResultPairing`（261007）只净化 **result 侧**，从没看过声明侧，因此同 id 声明照原样发出。

## 决策

- **写入侧**：`MessageV2.findToolPartByCallID(messageID, callID)` + `processor.adoptPersistedToolCall`。
  `ensureToolCall` 与 `adoptOrphanToolCall` 这两个"新建 part"入口，在内存 miss 后先按
  (当前 assistant 消息, callID) 查库；命中就复用原 part 并注册回 ctx。
  已终结（completed/error）的复用记为 `ToolCall.sealed`，`updateToolCall` 对 sealed 只读不改 ——
  否则迟到事件会把 part 推回 running，而对应 result 早已被 `completeToolCall` 的 running 卫丢弃，part 卡死。
- **发送侧**：`sanitizeToolResultPairing` 增加声明侧去重，同一条 assistant 消息内同 `toolCallId`
  只保留第一次声明，被丢弃的 id 记入新的 `droppedCallIds`。这一条同时兜住**已经污染的历史会话**
  （库里脏数据不清理）。
- 查询按 `part.message_id` 走索引，每条消息几个 part；且只在内存 miss（中断/revert 等异常路径）才触发。

## 备选与否决理由

- **不删 `ctx.toolcalls` 条目（settle 只 succeed Deferred）**：否决 —— 条目里带 `Deferred` 与执行状态，
  长期留在 ctx 里等于把「已终结但未清理」变成常态；而且跨 processor ctx（重试/新 step）照样 miss，
  修不干净。
- **在 `readToolCall` 里加库查询**：否决 —— 它是每个事件都走的热路径，正常流程内存必命中，
  把库查询放进去等于给正常路径加成本。查询只放在"新建 part"这两个罕见入口。
- **清理库里已有的重复 part**：本次不做 —— 改历史数据不可逆且需要用户批准；发送侧去重已能正常出站，
  库里第二条 part 保留反而是排查证据。
- **只在发送侧去重、不修写入侧**：否决 —— 中断后的迟到事件会**再执行一次**同一 call、
  且每次中断都给会话增加脏 part；发送侧只是兜底。

## 后果

- 正常路径（无中断、无重复事件）行为完全不变：`readToolCall` 内存命中，库查询不触发；
  `sanitizeToolResultPairing` 在无重复声明时返回原对象引用（用例守住了 identity）。
- 中断后的迟到事件不再产生第二条 part，也不会把已完成 part 推回 running。
- 已污染的会话（含本次这个）重启后由发送侧去掉重复声明即可继续，无需改库。
- 识别签名：同一条 assistant 消息出现两个同 `callID` 的 tool part；或 400 报错带
  `Duplicate value for 'tool_call_id' … in message[N]`（注意 `message[N]` 是 assistant 消息下标，
  不是会话里的第 N 条消息）。
- 验证：`message-v2.test.ts` 71 pass（新增 1 条声明侧去重用例）、`typecheck` EXIT=0（tsgo 崩溃回退
  TS 5.9.3）。
