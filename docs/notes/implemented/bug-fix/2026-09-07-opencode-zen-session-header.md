# opencode.ai zen 供应商补发 x-opencode-session 路由头

状态:implemented

## 问题

opencode.ai 的 zen 网关（含 Console Go，即本仓的 `opencode-go` 供应商，baseURL `https://opencode.ai/zen/go`）按 `x-opencode-session` 头做会话路由，缺头直接 400：

```
Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed
efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it  (type: MissingSessionID)
```

`session/llm/request.ts` 的非 redcode 分支此前只发 `x-session-affinity`（本仓自有的亲和头），zen 网关不认。260907 实测 `opencode-go` 全模型 100% 秒断。

## 决策

`LLMRequestPrep.prepare` 里判定供应商的有效 baseURL（`provider.options.baseURL` 优先，回落 `model.api.url`，即 models-dev 目录值）是否以 `https://opencode.ai/` 开头，是则在请求头里追加 `x-opencode-session: <sessionID>`。

值用当次会话 ID、按请求注入，只能走 `streamText({ headers })` / `prepared.headers` 通道——SDK 客户端按 `{providerID, npm, options}` 哈希缓存，把随会话变化的头放进 options 会打爆缓存。`model.headers` 与 `chat.headers` 插件仍在后面展开，可覆盖。

## 备选与否决理由

- **在 provider.ts resolveSDK 的 options.headers 里加**：否决——SDK 客户端按 options 哈希缓存，会话级头会导致每个会话各建一套客户端；且那里拿不到 sessionID。
- **静态写进用户配置（redcode.jsonc provider headers）**：否决——头值必须随会话变，静态值只能骗过路由检查、丢失亲和语义。
- **无条件对所有供应商发这个头**：否决——别的网关不认识，多余头污染请求面。

## 后果

走 opencode.ai zen 的供应商（`opencode`、`opencode-go`）恢复可用。判定基于 URL 前缀 `https://opencode.ai/`：用户自建反代若换了域名则不会注入（反代通常自行补头，属预期）。此头只影响 HTTP 传输层，不进模型上下文，无 token/KV cache 影响。
