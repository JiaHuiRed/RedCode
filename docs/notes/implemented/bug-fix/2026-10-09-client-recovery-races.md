# 客户端恢复路径的竞态修复：TUI 提问恢复与 GUI 深窗口权威刷新

状态:implemented

## 问题

0.12.4 第三方审计（GPT 知微）+ 本轮源码复核确认三个同源问题：**客户端恢复路径要么缺恢复拉取，要么迟到响应覆盖实时状态**。

1. **TUI 重连不补拉提问**（`packages/opencode/src/cli/cmd/tui/context/sync.tsx` 重连分支）：SSE 只推连接后事件、无 Last-Event-ID replay，重连（`serverConnections > 1`）只做 `reconcileCurrentSession()`——其 `loadSessionSnapshot` 拉的是当前会话消息快照，**不含 `question.list`**。问题挂起时重启/断线重连，TUI 弹窗不出现、输入框不禁、模型无限等。GUI bootstrap 早有同款恢复、run 管道模式也有，唯独 TUI 缺（0.12.4 的 385ffba0 只补了重启与重连后恢复的**事件消费侧**，没补**重连触发侧的拉取**）。
2. **启动拉取竞态**（sync.tsx bootstrap `optionalRequests`）：`question.list` 迟到响应被无条件 `upsertQuestion` 全量插入——拉取期间用户已 reply/reject 的问题会被旧快照复活：弹窗残留、模型侧收到假「拒绝」。
3. **GUI 深历史 + reset 回退不同步窗口**（`packages/app/src/context/directory-sync.ts` refreshSnapshot + `session-changes.ts` catchup）：短期变更日志 reset（裁剪/缺号/禁用）时 catchup 回退快照并 ACK 服务端游标，但快照合并对 `meta.newer[key]`（用户在深历史）直接 `{ messages: old, keepCursor: true }` 保留旧窗口——已删除消息留在窗内、窗口外更旧消息的更新丢失，且下一轮补拉已从新 cursor 开始，断点处内容永久陈旧。

复现均为隔离夹具实跑：TUI 用真实 Sync harness（mock helper/project/sdk/kv，import 真 `init()`）断言恢复行为；GUI 用真实 `createDirSyncContext`（mock server-sync + 真 QueryClientProvider + createRoot）1000 消息深翻 3 页后删 msg_0800 / 改 msg_0570，断言已删消息出窗、更旧内容刷新、消息详情 1 次请求、cursor 收敛。

## 决策

- **TUI 抽 `createQuestionRecovery`**（`cli/cmd/tui/context/question-recovery.ts`）：每次 `recover()` 生成请求对象，拉取期间 `changed(id)` 记录实时事件（asked/replied/rejected 三处调用），响应到达后按 id 合并——快照里有、实时已关闭的删除，实时状态优先；代次门禁（只最新一轮可 apply）+ workspace 变更/dispose 作废迟到响应。接入点：bootstrap optionalRequests 的 `question.list` 改调 `recover()`；重连分支 `reconcileCurrentSession()` 后追加 `recover()`（失败 `Log.Default.warn`，不阻断）；`apply` 改 `reconcile(grouped)` 整体替换 + `request_workspace` 只补不覆盖。
- **GUI `fetchRetainedMessageWindow`**（`context/session-changes.ts`）：深窗口 reset 时先以窗内前 limit 个 ID 逐个 `client.session.message` 找首个存活锚点（404 跳过），再 `after` 该锚点拉 limit-1 页、首条拼回；全删返回 undefined 回退旧路径。refreshSnapshot 对 anchored 路径：`removedMessageIDs(old, next)` 删除离窗消息、`keepCursor=anchored`、`cursor = meta.cursor ?? 首条 id`、`newer = anchored && !complete`。非 newer-gap 路径语义不变。
- **测试等待信号**：`question.test.ts` `waitForPending` 从订阅当前实例 Bus 改为订阅 GlobalBus "event"（owners 合并的 pending 只有全局通道能收到），跨目录用例用 fork + `pollWithTimeout` 等 listener 装上再发第二条提问——等真实信号，不 sleep。

## 备选与否决理由

- **SSE 加 Last-Event-ID replay**：否决——需服务端全量事件日志（现仅 experimentalWorkspaces 开启），改动面远大于客户端恢复；短期变更日志（session_change）已提供有界游标，是现成的对账锚点。
- **重连时全量 rebootstrap（照搬目录级）**：否决——目录 rebootstrap 15s 冷却、不重拉打开会话消息，且重量级；question.list 是单次轻请求，缺什么补什么。
- **TUI 迟到的 question.list 响应直接丢弃（不做合并）**：否决——启动拉取与实时事件在真实网络下必然交叠，简单丢弃会让慢网络下的启动恢复时有时无；合并语义（实时优先）才是确定性的。
- **GUI reset 后直接跳最新页（放弃深窗口）**：否决——用户正在看的位置被抽走比内容陈旧更糟；锚点续拉保留视图连续性与边界连续性（newer-gap 标记语义不变）。

## 后果

- TUI 行为变化：断线/重启重连后会补拉 pending 提问并恢复弹窗；拉取期间被关闭的问题不会被迟到响应复活（旧弹窗残留、模型假拒绝这两类症状消失）。恢复失败只 warn，不阻断重连主链。
- GUI 行为变化：reset/快照回退后，用户翻看的深历史窗口内被删消息会移除、窗口遮挡外被改的旧消息会刷新；代价是回退路径多至 `limit` 次 `session.message` 单条查询（上限 `min(HELD_MESSAGES_PER_SESSION, messageWindowLimit(...))`，仅在 reset 且深窗口时发生，不在常态路径上）。
- 未动：SSE 协议、事件载荷、短期变更日志表结构、跨目录可见性设计（owners 合并是显式决策，留产品层）；模型可见内容零变化（无提示词/工具 schema 改动）。
- 验证：`test/cli/tui/question-recovery.test.ts` 7 例 + `test/question/question.test.ts` 15 pass（修复前跨目录用例整文件跑必超时）；GUI 五文件 61 pass（含深窗口 reset 集成夹具）；两包 typecheck 绿。
- 识别签名：若再见「TUI 断线后弹窗不出现」——先查 `serverConnections > 1` 分支是否仍只调 `reconcileCurrentSession`；「弹窗里问题已被回答/拒绝」——查 recover 合并是否漏了某个 changed 调用点；「深历史回退后消息内容不刷新」——查 refreshSnapshot 的 anchored 路径是否被非 newer-gap 分支绕过。
