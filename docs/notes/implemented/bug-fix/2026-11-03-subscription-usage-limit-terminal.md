# 订阅额度耗尽立即终止，不再自动重试

- 日期：2026-11-03
- 状态：implemented
- 相关：`packages/opencode/src/provider/error.ts`、`packages/opencode/src/session/retry.ts`、`packages/opencode/test/provider/error.test.ts`、`packages/opencode/test/session/retry.test.ts`

## 背景

GLM Coding Plan 与 ChatGPT 订阅都按窗口计量（5 小时 / 7 天 / 月）。窗口耗尽时供应商回 HTTP 429，但 body 里的业务信号明确表示「本窗口不会自己恢复」：

- ChatGPT（codex 后端，实测 2026-10-31）：

  ```json
  {
    "error": {
      "type": "usage_limit_reached",
      "message": "The usage limit has been reached",
      "plan_type": "plus",
      "limit_window_minutes": 300,
      "resets_at": 1793423554,
      "resets_in_seconds": 12640
    }
  }
  ```

  响应头同时带 `x-codex-primary-used-percent: 100`、`x-codex-primary-reset-at`。

- GLM Coding Plan（实测 2026-10-15，`zhipuai-coding-plan`）：

  ```json
  { "error": { "code": "1310", "message": "您已达到每周/每月使用上限，您的限额将在 2026-10-18 23:29:52 重置。" } }
  ```

  z.ai 官方错误码里还有 `1308`（`{number}{unit}` 窗口，含 5 小时）、`1316`~`1321`（5 小时/7 天 + 无额外余额/月消费上限）、`1113`（余额不足）。

AI SDK 把所有 429 都标成 `isRetryable: true`，`SessionRetry.policy` 据此重试到 `RETRY_MAX_ATTEMPTS`（10 次，单次等待最长 10 分钟）。真机记录里两条 `gpt-6.1-terra` 失败消息（2026-10-30 09:37、2026-10-31 09:14）从创建到落错误分别耗了 1646 / 1648 秒，期间没有任何 part 产出——用户看到的是「还在请求」，实际每次都撞同一个已经耗尽的窗口。窗口类额度不会在重试周期内恢复，重试纯属白等。

## 决策

把「订阅额度耗尽」归成不可重试的终止信号：

- `provider/error.ts` 在溢出判断之前识别额度错误：codex 的 `error.type === "usage_limit_reached"`、z.ai 的额度错误码集合、`insufficient_quota`，以及 429 上明说 usage limit / 使用上限 / 额度用尽的文案兜底（防网关吃掉错误码）。
- 返回 `isRetryable: false`，沿用现有 `halt` 路径：本轮立刻以错误结束，会话转 idle，UI 错误卡片与桌宠 error 状态都会出现。
- 错误 message 直接写清哪个窗口、何时重置、该做什么：ChatGPT 从 `limit_window_minutes` + `resets_at` / `resets_in_seconds` 组装；GLM 保留供应商原文并追加「已停止自动重试」。
- 瞬时限流保持可重试：GLM `1302`（rate limit for requests）、`1305`（overloaded）、普通 5xx、断流/首事件超时都不受影响。

判定放在错误解析层而不是 `SessionRetry.retryable()`：原始 `APICallError` 与归一化后的 `APIError` 都会经过 `MessageV2.fromError`，解析层改一次就能让生产路径的两道判定一致；测试同时守住原始错误和归一化结果。

## 备选

- **按重置时间决定是否重试（例如 < 2 分钟才重试）**：否决——重试预算内能恢复的窗口极少，而多一条时间判据就多一个边界；用户明确要的是「立刻停下好切模型」。
- **自动切换模型后继续本轮**：否决——切哪个模型、是否保留上下文是用户决策；自动切会悄悄改变任务执行者。
- **所有 429 都不重试**：否决——每分钟限流是常见且能自愈的，误杀会牺牲正常恢复。
- **只改 `SessionRetry.retryable()`**：否决——原始错误先过一遍策略，只在归一化结果上改会留下一条仍可重试的路径。

## 后果

- 窗口耗尽的第一次 429 就终止，不再出现十几分钟「假工作」。用户需要切换模型后重发消息继续。
- 错误信息含重置时刻（本地时区）；5 小时与 7 天窗口用 `limit_window_minutes` 区分。
- 唯一剩余延迟是那一次请求本身的上游排队时间；不再有 10 次重试叠加。
- 识别签名：日志/消息里出现 `usage_limit_reached` 或 z.ai 额度码，且随后仍有 `session.status = retry` → 说明本修复未生效。
