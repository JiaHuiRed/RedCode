# MCP stderr 证据脱敏补全：多格式遮蔽，原始文本不进普通日志

状态:implemented

## 问题

0.15.0 审计 RC-015-02（P1）：`mcp/evidence.ts` 的 `KEY_VALUE` 只认 `KEY=VALUE`，独立样例复核显示 `Authorization: Bearer secret`、`{"apiKey":"secret"}`、`x-api-key: secret` 都不会被遮蔽；同时 `mcp/index.ts` 仍把**未处理的原始 stderr** 写进 `log.info`。上一版新增的 512 字符截断只限制长度，不等于脱敏——凭证截断后仍然是凭证。

## 决策

`evidence.ts` 收敛出单一 `redact()`，证据（`sanitizeEvidence`）与日志 sink 共用同一套规则：

1. `Authorization` / `Proxy-Authorization` 头整行遮值（Bearer、Basic、自定义 scheme 全覆盖，避免只遮 scheme 留下凭证）；
2. JSON 引号键值：键名含敏感词（TOKEN/SECRET/PASSWORD/CREDENTIAL/API_KEY/ACCESS_KEY/PRIVATE_KEY/COOKIE）时整值遮；
3. 正文里的 `Bearer <token>`；
4. `KEY=VALUE` 与 `KEY: VALUE`（key 允许连字符，覆盖 `x-api-key`）。

日志侧改为行缓冲：`createStderrEvidence().push(chunk)` 返回**已补齐且已脱敏**的完整行，`mcp/index.ts` 只把返回值交给 `log.info`；未换行的尾行留在缓冲里，跨 chunk 拆开的赋值因此在同一行内被整段遮住。原始文本只存在内存的有界缓冲（4000 字符），失败时经 `describeLocalFailure` 脱敏后进 `status.error` 与错误日志。

## 备选与否决理由

- **只做 allowlist（只放行已知安全行）**：否决——MCP server 的报错格式不可枚举，会把「缺依赖」「权限不足」这类真正有用的行一起吞掉，违反证据链的初衷。
- **只在 `status.error` 脱敏、日志保留原文**：否决——审计明确指出原始 stderr 不该进普通日志；日志会随反馈/工单扩散。
- **为 `Basic` 做无头推断**：否决——`Basic authentication failed` 这类普通英文会被按长度误判成凭证；Basic 的真实形态（`Authorization: Basic ...`）已由头整行规则覆盖。

## 后果

- 误遮是允许的代价：键名里含 `token` 的普通字段（如 `tokenizer`）也会被遮；诊断价值让位于「不泄露」。
- 没有换行的尾行不会进普通日志，只随失败证据出现；这是有意的：无法判断行是否完整时不做「已脱敏」的承诺。
- 识别签名：若用户反馈「MCP 报错里该有的信息没了」，先看是否被整行 `Authorization` 规则或敏感键名规则误遮。
