# 流看门狗按"在途工具集合"判豁免，测试改为直调真实现

状态: implemented

## 问题

`guardFirstEvent`（`packages/opencode/src/session/llm.ts`）用单个布尔 `state.local` 表示"本地工具阶段"：任何 `tool-input-*` / `tool-call` 置 `true`，`tool-result` / `tool-error` 置 `false`（另有一条 `text-` / `reasoning-` / `step-` 顺带置 `false`）。单布尔的前提是"同一时刻至多一个工具在跑"，而 AI SDK 一个 step 里可以并行发出多个 `tool-call`，各自的 `tool-result` 陆续返回。

先返回的快工具把 `local` 清成 `false` 后，仍在执行的慢工具期间流上没有任何事件——120 秒后 `IDLE_EVENT_TIMEOUT` 看门狗把这段空窗判成「网关停摆」，`ctrl.abort()` 掐掉整轮。

实证（260915 日志，同一会话两次 `StreamIdleTimeoutError`，静默 123 / 124 秒）：被中断的两条消息里 `read` 与另一条 `bash` 均已 completed，而 `bash` 那条 `redcode doctor --json`（timeout 180000）的状态是 `error`、`state.error = "Tool execution aborted"`——慢工具是被看门狗掐的，不是它自己失败。

第二处问题在测试侧：`test/session/llm-idle-guard.test.ts` 里有一份逐行复刻的 `guard` shadow 实现，而**复刻版从来没有 `local` 逻辑**。真实误杀因此在测试里完全隐形：同文件全部用例一直绿。

## 决策

- `state.local: boolean` 换成 `state.pending: Set<string>`，按 `toolCallId` 记账：`tool-call` 入，`tool-result` / `tool-error` 出。看门狗判据改为 `state.pending.size > 0 → 跳过`，**全部工具都回来才恢复计时**。
- 入口取 `tool-call` 而不是 `tool-input-*`：`tool-call` 才代表参数齐了、本地开始干活；参数流期间流上持续有事件刷新 `last`，本就不需要豁免。反过来若把参数流算作在途，参数中途断掉会让集合永不清空——永久免疫比误杀更糟（看门狗彻底失效）。
- 删除 `text-` / `reasoning-` / `step-` 顺带清本地态的分支：那些事件只证明网关在说话，不能证明本地工具已跑完——并行工具场景下正是它把慢工具的豁免放跑了。
- `guardFirstEvent` 导出，并接受第三个参数 `limits: { first; idle; tick }`（默认值即三个常量）。测试不再复刻，直接 `import` 真实现并注入毫秒级阈值（`first` 300ms / `idle` 400ms / `tick` 25ms），秒级跑完而不必等 75 / 120 秒。
- 新增两条用例：并行工具（快工具已返回、慢工具仍在跑的静默期内不得被误杀）；工具全部结束后网关静默仍须报 `StreamIdleTimeoutError`（防豁免做成永久免疫）。

## 备选与否决理由

- **只调大 `IDLE_EVENT_TIMEOUT`**：否决——慢工具耗时没有上界（等用户点权限更没有），阈值调到多少都会被下一个更慢的工具击穿，同时钝化对真停摆的检测。
- **保留 `local` 布尔，只删掉 `text-`/`reasoning-`/`step-` 那条清态分支**：否决——只堵住并行工具的一种触发路径，快工具自己的 `tool-result` 仍会清态，同 step 的慢工具照样误杀。
- **在途计数也把 `tool-input-*` 作为入口（更贴近原实现）**：否决——参数流是网关侧事件，计入在途会让参数中断时集合永不清空（见上）。
- **测试继续复刻 shadow 实现**：否决——本轮 bug 正是因为复刻没跟上实现而隐形；导出 + 注入阈值让测试跑真实现，同类漂移不可能再发生。

## 后果

- 判定语义更窄也更准：只要还有工具没回来就不计时，其余时间一律按事件间隔计时。
- 代价：若某个工具的 `tool-result` 永远不来（既不超时也不出错），看门狗在该轮不再兜底。本地工具自身有超时（bash 600s / repo_clone 300s），权限等待本就没有上界，故不额外加豁免上限；真要兜底应在工具侧解决。
- 识别签名：日志里 `llm.stream idle watchdog fired` 现在带 `pendingTools`（原先带 `local: false`）。若再见到该行且 `pendingTools > 0`，说明豁免逻辑又漏了在途工具。
