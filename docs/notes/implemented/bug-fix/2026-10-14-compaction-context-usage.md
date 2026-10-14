# TUI 压缩分割线改用模型实报上下文

状态: implemented

## 现场

同一会话里，压缩分割线显示过 `554,889 → 444,276` 和 `421,360 → 392,229`；状态栏对应的模型请求实报却是压前 `context=368,080`、压后 `context=183,469`。账本拆分：

- 压前：`input=2,896 + cache.read=365,184 = context 368,080`
- 压后：`input=150,189 + cache.read=33,280 = context 183,469`

分割线的 `tokens_before/after` 来自本地 `estimateModelMessages`，是选段/统计用的启发式估算，不是 provider 实报。两类数字被同样标成 `tokens`，导致用户把估值误当成上下文窗口真值，甚至在没有主请求实报时再次手动压缩。

## 决策

TUI 分割线不再显示 `tokens_before/after` 估算，改从消息账本取 provider usage：

- 压前值：marker 之前最近一个非 summary 主请求的 `tokens.context`。
- 压后值：marker 之后、下一条 compaction marker 之前，第一个非 summary 主请求的 `tokens.context`。
- 压后主请求还没完成时显示「待主请求实报」；在下一次压缩前没有发出主请求，则标记为被后续压缩取代，不借用估算值。
- 展开详情同时注明这是「压前最近主请求」与「压后首个主请求」的上下文，净减少/增加百分比只对两次 provider 实报计算。

状态栏和分割线共用同一实报字段。`tokens_before/after` 仍供现有 compaction 状态与估算逻辑使用，本改动不改压缩选择、目标配置或发送给模型的内容；TUI 不再把它们展示成真实窗口大小。

## 验证与影响

- 回归测试先红后绿，`test/cli/tui/compaction-fold.test.tsx`：14 pass / 0 fail。
- `packages/opencode` typecheck 通过（tsgo 崩溃后按脚本回退 TypeScript 5.9.3 成功）。
- 无模型请求、无 system prompt / tool schema / provider 参数改动；token 与 KV-cache 影响为零。
- 范围仅为 TUI 分割线；GUI 的 compaction 汇总仍读取持久化估算字段，未在本次修改。

回链：`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`、CHANGELOG Unreleased。
