# 放弃 OAuth 登录导致 sidecar unhandledRejection 退出

日期：2026-10-01 · 类型：bug-fix · 状态：implemented

## 现象与实证

260930 晚 GUI 弹出空体 503 后，`%TEMP%\redcode-sidecar-crash.log` 记录
`[sidecar-fatal] unhandledRejection: Error: OAuth callback timeout - authorization took too long`，
编译产物栈定位到 Codex 插件 `waitForOAuthCallback` 的 5 分钟超时 reject；
desktop `sidecar.ts` 的 `unhandledRejection` handler 随即 `process.exit(1)`，
后端 3 秒后自动重生。因此这不是「服务挂了没人管」，而是「一次被放弃的登录
杀掉了整个后端进程」。

## 根因

四个 OAuth 等待点都是**eager 启动 promise、消费点后置**：

- `plugin/codex.ts` `authorize()` 内 `waitForOAuthCallback()` 先启动，
  `callback()` 被授权 UI 调用时才 `await`；
- `plugin/xai.ts`、`plugin/digitalocean.ts` 同构；
- `mcp/oauth-callback.ts` `waitForCallback()` 由 `mcp/index.ts` authenticate
  先启动再打开浏览器，await 前调用方 fiber 可能被中断。

用户放弃登录（关掉浏览器/弹窗、fiber 中断）时 `callback()` 永不执行，
promise 无消费者；5 分钟超时（或 MCP `stop()`/`cancelPending`）reject 无人
接住 → unhandledRejection → sidecar 退出。

## 修法与备选

在 **promise 创建点**预挂空 catch：`callbackPromise.catch(() => {})`。这一处
覆盖所有 reject 来源（超时、取消、被顶替、服务器停止），且不改变语义——
迟到的或正常的消费者 `await` 时仍收到原始 rejection，由各自的错误处理路径
（GUI 展示 / CLI 提示）消化。

否决的备选：

- **reject 前检查是否有消费者**：Promise 无法查询消费者，不可行。
- **超时改为 resolve 错误对象**：改契约，所有 await 点连带改，侵入大。
- **只在消费点加 catch**：消费点可能永远不执行，治不了本症。

MCP 侧 `waitForCallback` 是导出函数，兜底放在函数内部而非调用点，覆盖
现在与未来的所有调用方。

## 边界

- codex 的 `pendingOAuth.reject("Login cancelled")`（用户点取消链接）与 xai
  的 superseded reject 同样被创建点兜底覆盖。
- 放弃路径静默无日志：放弃本身是用户主动行为，`stop()` 已有既有日志，
  不为它加常驻噪音。
- 三个 plugin 的 `waitForOAuthCallback` 为模块私有函数，未为测试扩大导出面；
  行为回归落在可导出的 MCP `waitForCallback` 上。

## 验证

- `test/mcp/oauth-callback.test.ts` 新增 2 条（共 6 条全绿）：cancelPending
  对等待中的消费者正常 reject；无消费者时 `stop()` 强制 reject 不产生
  unhandledRejection 且迟到消费者收到原始错误。第二条做过红测验证——
  移除修复后 Bun 直接把 unhandled rejection 报为用例失败。
- `packages/opencode` typecheck 0。

## 模型可见改动四问

1. 模型看到什么变了：无（纯进程内错误处理，无提示词/工具 schema 变化）。
2. token 影响：0。
3. KV cache 影响：无。
4. 注入项硬上限：不适用。
