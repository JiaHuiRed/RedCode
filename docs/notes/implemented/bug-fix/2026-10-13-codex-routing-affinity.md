# Codex 请求链路由隔离与最终 wire 模型路由提示

状态:implemented

## 问题

GPT-6.1 Sol/high 在无压缩、无模型切换的连续请求中仍出现暖缓存归零。现场先后记录 51,618 和 100,414 token 的输入全 miss，原始 vendor usage 明确为 `reported-zero`，不是 SDK 将缺失字段补成零。第二次请求前，上一请求命中 97,536 token。

历史数据库只作基线：剔除首次冷启动、模型/variant/turn 变化、压缩边界及超过五分钟的间隔，上一请求命中率至少 80% 的同链请求中，DCP 时期为 7/1134 次归零，后续截至前一晚为 10/159 次。样本跨日期、版本与工作负载，不能据此证明最新版回归，更不能将归零直接归因于 compaction。

定位到一处可复现的请求链串用：

- 标题生成使用首个真实 user 与主对话相同的 session。
- `x-redcode-turn` 原来只取 user ID；Codex 插件全局 map 只接纳这个键的首响应令牌。
- 标题先响应时，主对话自己的令牌无法替换标题令牌。本地真插件复现为 `title-route → title-route → title-route`，主对话返回的 `main-route` 被忽略；现场两个开场请求也返回不同令牌，而后续请求回传先到的标题令牌。

串用是客户端问题，但不是全部归零的已确认根因：第二次现场归零时，回传的是主对话自己的令牌。服务端明确报零也不等于客户端路由机制无责。

## 决策

### 请求链隔离

`LLMRequestPrep.codexTurnKey()` 以 `[sessionID, userID, agent, wireModelID]` 的 SHA-256 作为固定 64 字符 ASCII 键。只在 OpenAI OAuth 路径生成：

- 标题、压缩摘要与主对话不共享首响应令牌。
- 同线程、同 turn、同 agent、同模型的后续 step 保持同键。
- 跨 turn、线程、agent 或模型得到新键，不回传另一请求链的令牌。
- `session-id`、`thread-id` 和 `prompt_cache_key` 的既有语义不变；插件仍只存同链首个响应令牌，沿用 512 项上限。

实现位于 `packages/opencode/src/session/llm/request.ts`，测试直调生产 helper，并通过真实 `CodexAuthPlugin` 与本地 HTTP 服务验证令牌回传，不复刻存储逻辑。

### 模型路由提示

对照本地官方 Codex 源码 HEAD `12cca49c81c8aa6a37a5cc4e39964ee3b70f9458`：

- `codex-rs/core/src/client.rs` 的 `build_routing_hint_header()` 构造 `model=<wire model>`，仅有 service tier 时追加 `;tier=<tier>`。
- HTTP 请求在正文构造完成后，取实际 `request.model` 和 `request.service_tier` 填入 `x-codex-routing-hint`。

RedCode OAuth fetch 在最终 URL 重写后，从实际字符串或 Uint8Array JSON 正文取相同字段并覆盖旧 hint。缺失 tier 不猜默认档位；正文保持原样。错误 JSON 或缺失 model 只记不含正文的原因 WARN，仍将原请求交给后端处理，不增加重试。

取证在既有路由头白名单中新增 `x-codex-routing-hint`：只记录进程内 HMAC，单值仍限 1024 UTF-8 字节，超限跳过。请求头最多五项，响应 turn-state 一项；不记录提示词、认证、账号或令牌原文。

## 备选与否决理由

- **标题和主对话共用 user ID，首响应任选**：否决。不同提示词、不同请求链的并发响应会争同一个令牌槽位。
- **每次响应覆盖令牌**：否决。违背官方同 turn 首响应 OnceLock 语义；修作用域而不是破坏稳定性。
- **从 UI 模型或预转换 options 猜 routing hint**：否决。最终提供商请求中的 model/tier 才是路由依据。
- **将 Bun fetch 全面替换为显式 dispatcher**：未采用。本地现有路径五次连续请求复用一个 TCP 连接，不能先假定默认 fetch 每次新建连接；本地测试也不证明真实代理链路的连接亲和。
- **同批照搬 WebSocket / previous_response_id**：未采用。官方默认优先 WS，纯增量时续接上一 response；RedCode 当前 HTTP 主路径没有该请求链，改动涉及传输、失败回退、取消与历史一致性，应另行受控验证。
- **改变压缩策略或加重试掩盖归零**：未采用。本批不改压缩预算、历史投影、触发时机或重试次数。

## 后果与验证

- 新键与 routing hint 只改变传输层路由信息；实际缓存及套餐额度收益需要重编重启后的真机会话验证，不能从本地协议测试推断。
- 两个定向文件先出现预期失败，实现后 43 pass / 0 fail；覆盖辅助请求隔离、同链令牌不覆盖、跨轮/线程/模型隔离、可选 tier、错误 JSON 与字节正文透传、有界指纹及真实 WARN 日志脱敏。
- `bun run typecheck` 通过；tsgo 崩溃后仓库既定脚本回退 TypeScript 成功。不运行全量测试，不调用真实供应商，不覆盖运行中的 exe。
- 生效后看同一请求链的 `headerHashes` 是否稳定，routing hint 是否在场，以及 `request.provider-usage` 的显式零事件；继续排除冷启动、切模型与压缩边界。令牌稳定仍归零时，不把本批修复当作根治。

## 模型可见四问

1. **模型看到什么变了**：提示词、工具表、正文、模型与推理参数均未改；只更新路由头及脱敏日志。
2. **token 影响**：固定前缀零增量，原始请求正文逐字节透传。
3. **KV cache 影响**：不移动或改写模型前缀；路由目标可能变化，实际命中效果待观察，不承诺服务器缓存必然保留。
4. **硬上限**：无新增模型上下文注入；新增指纹仍是固定长度 HMAC，沿用每值 1024 字节输入上限，turn-state map 沿用 512 项上限。
