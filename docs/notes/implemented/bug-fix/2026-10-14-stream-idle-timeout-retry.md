# 保留流静默超时的可重试分类

状态: implemented

## 现场

2026-10-14 同一会话多次发生 `StreamIdleTimeoutError`：LLM 首事件正常到达，之后静默 120–124 秒，被 watchdog 中断。日志中的 assistant error 均被持久化为 `UnknownError`，中断后没有同 message 的新请求，长任务只能等用户再次发送消息才继续。

## 根因

`SessionRetry.policy` 先调用 `MessageV2.fromError` 归一化失败，再交给 `retryable` 分类。`MessageV2.fromError` 会把自定义的 `StreamIdleTimeoutError` 转成 `UnknownError`，丢掉原始 `_tag`。虽然 `retryable` 对原始错误类有单测，但 processor 实际传入的是归一化后的错误，因此分类落到不可重试。

## 修复

- retry policy 先用原始 failure 的 `_tag` 判定 transport watchdog 错误；未匹配时再用归一化后的 `MessageV2.APIError` 处理供应商错误和 retry-after headers。
- `retryable` 接收 unknown 并安全读取可选的 `data`，保持普通错误和非对象输入不抛异常。
- 重试次数、退避与 120 秒 watchdog 阈值不变；持续失败仍按既有上限收敛并显示错误。

## 验证与影响

- `retry.test.ts` 回归先红后绿：确认原始 `StreamIdleTimeoutError` 被归一化为 `UnknownError` 时，policy 仍发出 retry 状态；33 pass / 0 fail。
- `packages/opencode` typecheck 通过（tsgo 崩溃后脚本回退 TypeScript 5.9.3 成功）。
- 无模型可见内容、请求参数或前缀变化；token 与 KV-cache 影响为零。

回链：`packages/opencode/src/session/retry.ts`、CHANGELOG Unreleased。
