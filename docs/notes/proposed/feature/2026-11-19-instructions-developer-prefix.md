# GPT-6.2 instructions 缓存缺口根因确认与修复方向：固定指令改走 input 前缀 developer message

状态：proposed（2026-11-19 调研定案；实施待拍板）

## 问题

`gpt-6.2-sol` / `gpt-6.2-astra` 每轮固定 miss ~21.7k（instructions 段），稳态命中率上限 ~92.5%，而 6.1 家族同组装全命中。261118 字段归因实测（[归因诊断](../../implemented/feature/2026-11-18-cache-attribution-diagnostics.md)、[增量工具声明提案](2026-11-18-incremental-tool-declarations.md)「字段归因实测」节）确认缺口主体是 instructions 段每轮全 miss，当时结论「本地杠杆只剩压缩 instructions 体积或等模型更新」。同时 6.1 家族的 60M token 长任务实测 Cache Turn 99.75% / Hit 98.31%（Miss 898k）——健康形态的分界线严格落在模型版本上。

261119 对 Codex 官方源码（`E:/AI/codex`，d1d1ba0b83）与 OpenCode 最新源码（`D:/AI/opencode`，88ca792e02）的调研，把「instructions 不缓存」的病根钉到了**序列化位置**：

## 证据链（三源闭环）

### 1. Codex 官方：请求层从来没有顶层 instructions 字段

`codex-rs/codex-api/src/common.rs:394` 的 `ResponsesApiRequest` 顶层字段为 `model / stream / input / tools / tool_choice / reasoning / store / include / prompt_cache_key / prompt_cache_options / text / client_metadata / request_country`——**没有 `instructions`**。固定指令由 `codex-rs/core/src/client.rs:1259-1291` `build_responses_request` 构造进 `input` 数组头部：

- `BaseInstructionsFragment` → `developer` 角色 Message（content kind `model.base_instructions`），`core/src/context/base_instructions.rs` 文件头注释：*"Initial base instructions, recorded in history for incremental-tools windows"*。
- 前缀条目 ID = `Uuid::new_v5(Uuid::new_v5(NAMESPACE_OID, thread_id), 内容 bytes)`——注释原文：*"These prompt-only items are rebuilt on every request. Hash their visible payloads within the thread so retries and resumed sessions preserve their identity."*
- 工具双轨：普通 Responses API 走顶层 `tools`；仅 Responses Lite（RLite）走 input 内 `additional_tools`（developer 条目）——与 #59832 原文一致，也修正了增量工具声明提案早先「顶层 tools 不缓存」的旧结论（261118 已按归因实测修正过一次）。
- 缓存键双通道：顶层 `prompt_cache_key`（session_id；子代理 `source:parent_thread_id`）+ `session-id` header（ChatGPT 网关按 header 派生亲和）。

### 2. OpenCode：上游 11-17 已修，注释直接点名病根

- **#64542**（`7ca7b3feba`，11-17 17:58，比我们实测早一天）：openai 路由 system 从顶层 instructions 改为 `{type:"message", role:"developer", content: system}` 置于 `input` 首位。diff 注释原文：*"GPT-6.2 never caches top-level `instructions`"*。附带 fixture **`caches-the-system-prompt-on-gpt-6-2-sol.json`**——上游已实测验证修复后 6.2-sol 的 system prompt 进缓存。
- **#64544**（`de291ab7b1`，24 分钟后）：下沉到公共 `packages/ai/src/protocols/open-responses.ts` `lowerConversation`（829 行注释：*"The system prompt leads `input` as a developer message: GPT-6.2 models never cache top-level `instructions`."*），覆盖全部 Responses 路由（xAI/venice 等），回归录像同步更新。修复后上游全仓无顶层 instructions 发送残留。

### 3. RedSpace 实测与继承考古

- 261118 实测与上述病根严丝合缝：Sol 第二轮 input 数组部分（历史）命中 12,800、instructions 段（数组外顶层字段）21.7k 全 miss——**分界线就是「进不进 input 数组」**。6.1 全命中说明 6.1 端点策略覆盖顶层字段。
- 继承考古：`options.instructions` OAuth 分支自 opencode 分叉提交 `e2dd4649`（"move shared Chat/Code engine out of opencode directory"）即存在，此后组装从未改动（仅 Soul、项目记忆两次内容叠加）——RedSpace 至今跑的正是上游 **#64542 修复前**的形态。三方证据（上游修复 + 我方实测 + Codex 官方形态）指向同一结论。

## 决策（proposed，两阶段）

**第一阶段（主修，改发送位置、不改组装内容）**：6.2 OAuth 请求的完整固定指令不再写入顶层 `instructions`，改为置于 `input` 数组首位的 `developer` Message。system 字符串的拼接逻辑（env→instructions→Soul→conversation contract→companion→MCP guide→skills→日期→运行时规则→active goal→vision→canary）一字不动，`prefix-shape`、msg-pin、诊断体系照常工作。

实施载体已确认现成：`@ai-sdk/openai` v4.0.59 自带 `providerOptions.openai.systemMessageMode`（`"system" | "developer" | "remove"`，**推理模型默认已是 developer**）与 `prompt_cache_breakpoint`（per-message 显式缓存断点）。即：OAuth 时不再设 `options.instructions`（`session/llm/request.ts:94`），把 system 作为普通 system message 放回 messages 头部，AI SDK 自动渲染为 input 首个 developer 条目。

**第二阶段（按实测决定，暂不做）**：若日期、Active Goal、Soul 更新等动态段随同 Developer Message 导致较大缓存损失，再研究「稳定 Developer Message 与动态尾部消息的分离」与 `prompt_cache_breakpoint` 显式断点——上游 OpenAI 公开 API 支持该机制，OAuth 端点必须另行实测。

### 必须遵守的边界（上游已踩过的坑）

1. **压缩摘要路径保留顶层 instructions**：`responses-compaction.ts` 注释——/compact 会把开头 developer message 回显进输出窗口，compact 时 system 留在顶层 instructions，OpenAI 仍能读到 input 前缀版焐热的缓存。RedSpace 压缩摘要请求同样处理（`c067fdae` 已拆分该路径，钩子现成）。
2. **诊断面同步**：`prefix-shape` 与 msg-pin 须把「system → developer message」识别为同一段；这是模型可见装配变更，走四问流程（固定前缀字节位置变化 = 一次性缓存重建，发布说明记录）。
3. **硬门槛实测**：developer role input 条目对我方 6.2 OAuth 路径（`store:false` + auth）的接受度，实施前先发一轮验证请求；上游 fixture 证明可行但供应商配置可能不同。
4. 6.1 路径保守起见保持原状（模型分派），待 6.2 验证收益后再决定是否统一。

## 备选与否决理由

- **压缩 instructions 体积（261118 的旧杠杆结论）**：降级为辅助手段——根因既已定位为序列化位置，改位置是根治，压缩体积只是缩小损失面。
- **等模型更新**：上游已用同一修法实测拿到 6.2-sol 缓存（fixture 为证），等不再必要。
- **重新设计固定前缀组装系统（照搬 Codex 的 v5 稳定 ID / 内容哈希分层）**：否决——RedSpace 已有 prefix-shape、msg-pin、跨进程工具钉死等完整稳定性设施，Codex 的身份管理解决的是它自己的前缀条目重建问题；先改发送位置验证收益，分层需求实测后再议。
- **全路由（含 6.1）一刀切切换**：否决首版——上游全切有全量回归录像兜底，我方先按模型分派隔离验证，避免把 97%+ 的 6.1 现状当赌注。

## 后果

- 6.2-sol/astra 的 22k 固定 miss 预期归零，稳态命中率回到 98% 档（对齐 6.1 长任务实测形态）；每次压缩/历史重建后 instructions 段不再独立付全款。
- 固定指令成为 input 历史的一部分：投递回声、压缩窗口选段、(msg-pin) 三处现有锚点需确认认识 developer 条目（锚点已锁 `msg_`/`prt_` 机读前缀，新增条目沿用同一 id 体系即可）。
- `session/prefix-shape.ts` 需在实施 commit 里给出改造前后 KV cache 影响对照（一次性重建，之后逐轮收益）。
- 与[增量工具声明提案](2026-11-18-incremental-tool-declarations.md)合并实施即为 Codex Responses Lite 完整形态；两者共享同一硬门槛实测。

## 相关

- 增量工具声明提案（tools 进 input，同族改造）：`docs/notes/proposed/feature/2026-11-18-incremental-tool-declarations.md`
- 字段归因诊断（实测方法与数值）：`docs/notes/implemented/feature/2026-11-18-cache-attribution-diagnostics.md`
- Codex 源码：`E:/AI/codex/codex-rs`（client.rs 1259-1291、base_instructions.rs、codex-api/src/common.rs:394）
- OpenCode 源码：`D:/AI/opencode/packages/ai/src/protocols/`（open-responses.ts:827 lowerConversation、#64542 `7ca7b3feba`、#64544 `de291ab7b1`、fixture caches-the-system-prompt-on-gpt-6-2-sol.json）
- RedSpace 发送位置现状：`packages/redspace/src/session/llm/request.ts:94`（`options.instructions`）+ `@ai-sdk/openai` v4（providerOptions.openai.instructions → 请求顶层字段；systemMessageMode/prompt_cache_breakpoint 已内建）
