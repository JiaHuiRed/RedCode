# 压缩请求证据链：DCP 数字回执 → 宿主桥 → 出站前缀观察

- 日期：2026-10-04
- 状态：implemented
- 回链：`packages/opencode/src/tool/registry.ts`（metadata 桥）、`packages/opencode/src/session/request-evidence.ts`（观察器）、`../Qiu/RedCode-dcp` 仓 `lib/compress/pipeline.ts`（回执产生点）、CHANGELOG 0.11.18 条目

## 动机

billion-context 调研（2026-10-04）的优先借鉴项是**成本归因**与**出站前缀回归防护**：DCP 压缩本身保留摘要能力已经够好，缺的是"每次压缩到底省了多少、下一次出站请求的前缀是否如预期变化"的证据链。本批不改摘要算法、不改触发配置、不加检索工具。

## 设计（三段接缝）

1. **DCP 回执**（`lib/compress/pipeline.ts` finalizeSession 末尾）：压缩完成时通过既有 metadata 回调附加纯数字回执
   `{dcpCompression:{version:1,runId,blockCount,inputTokensEstimated,summaryTokensEstimated,netSavingsEstimated}}`。
   口径：input = 新块新压源消息 tokens + 被消费旧块的**摘要** tokens（不是它们的原始源，避免双重计费；同批去重）；summary = 新块 summaryTokens 之和；net 有符号不钳负。缺失块引用时 warn 并跳过，不伪造数据。模型可见输出（原始字符串）不变。
2. **宿主桥**（`src/tool/registry.ts` fromPlugin）：插件的 void metadata 回调原先返回未执行的 Effect（数据丢失）。现在同步聚合回调的 title/metadata，execute 结束后经 `toolCtx.metadata` 提交一次；结构化结果的显式 title/metadata 优先于回调值。
3. **出站观察器**（`src/session/request-evidence.ts`，新文件）：按 `sessionID|modelKey|runtime` 分桶（sessionEvictor 有界），在两条运行时的真实出站边界捕获 wire body——
   - AI SDK：`RequestEvidence.middleware` 挂在既有 wrapLanguageModel 中间件之后，读 `result.request.body`；
   - native：`native-runtime.ts` 用 Proxy 包装实际 fetch（含 OAuth fetch），只读 string/Uint8Array body，不消费流、不改语义。
   捕获后按 system/tools/history 三段逐条指纹（sha256+长度，**不落原文**），分类 baseline/unchanged/append/rewind/rewrite；step-finish 记录 usage 与 cache 字段（reported/unknown 显式区分，估算轮标 output-only-estimated）；compress 工具的 tool-result 校验并记录数字回执，待到下一次出站时作为 afterCompression 附在观察里。成本计算仍归 Session.getUsage（观察器只记原始 usage，不平行计价）。日志走 `request-evidence` service，body >512KiB、消息 >2048、待定回执 >16 均有硬上限。

## 模型可见四问

1. 模型看到什么变了：**什么都不变**——compress 工具描述、参数 schema、返回字符串、nudge 全部原样；回执与观察只存在于 part metadata 与日志。
2. token 影响：0（无新增注入面）。
3. KV cache 影响：不动（请求结构逐字节不变）。
4. 注入项上限：无注入项；观察器自身有界（512KiB body、2048 消息、16 待定回执、sessionEvictor 淘汰）。

## 验证

- DCP：`tests/compress-evidence.test.ts` 5 条（先红后绿；含嵌套块只计旧摘要、批量去重、负收益、无私密文本泄漏）。14 条压缩相关既有测试不回归；`bun run typecheck` 过；`npm run build` 过。
- 宿主：`test/tool/registry.test.ts` 新增 2 条真实 registry 回归（string/structured 结果 × 回调聚合 × 显式优先），修复前失败、修复后 20 条全过。
- 观察器：`test/session/request-evidence.test.ts` 8 条——SDK 中间件捕获的 body 与真实 wire body 逐字节一致（fake upstream）、native OAuth fetch 观察不改语义、四类前缀变迁、多会话桶独立、超限不比对、Responses/Anthropic/Gemini 形状、cache 显式零 vs unknown、回执校验与负收益。opencode typecheck 过。

## 边界与未做

- native 路径的 tool-result value 目前可能不带 metadata（桥接编码差异），观察器记 `metadata-unavailable`，不伪造。
- 本批**未**运行真实付费模型验证；Step 5 Preview 隔离冒烟另行执行。
- TTL/提供商侧缓存缺失不做因果断言：观察器只回答"前缀变没变、变了哪段、压缩回执是多少"，不直接归因 cache miss 原因。

## 长请求诊断补充

GPT 长会话中已核实一次 `96.67% → 17.22% → 96.73%` 的真实 provider 缓存读波动，中间没有 compress 或模型切换；这些请求原来都因 512KiB 限制跳过指纹，因此不能从旧日志判定客户端改写还是提供商路由/缓存变化。本批补证据，不宣称已修复缓存根因。

- `experimental.requestEvidence` 是经过 Schema 校验的配置：默认 body 16MiB、4096 条消息、16 个待定压缩回执；安全上限分别为 64MiB、16384、128。配置拥有方显式 resolve，SDK/native 共用。字节数组在解码前检查大小；仅在预算内解析，不留正文。
- 保留 section 与投影 wire 指纹，另记录完整序列化 body 的 SHA-256，以及实际出站 model/cache-key/options/retention/service-tier/reasoning 字段的匿名指纹。不是推测 `ProviderTransform` 的默认值。
- AsyncLocalStorage 将同一次 SDK/native 调用与最终 Codex transport 关联；在实际账号头与 URL 重写后观察 body、账号、目标及响应请求 ID。账号/目标/缓存亲和字段用进程内随机盐 HMAC；不记录账号值、密钥、原始头或正文。缺少账号信息就是未知。同一请求 ID 连接 `request.prefix`、`request.transport` 与用量；不新增 HTTP header，也不改变请求 body、缓存键、fetch 参数或响应对象。
- 捕获/日志失败不能使请求失败；预算溢出仍明确记录 unsupported。此代码加载后才能采集新证据，不能补回旧请求全文。进程间匿名指纹不可直接比较。
- 合成指纹耗时探针（单条 ASCII 消息，配置预算 32MiB，三次样本，包含日志调用）：约 1MiB 为 7–11ms、8MiB 为 71–107ms、16MiB 为 121–199ms；不是 provider 延迟或缓存改善证明。
- 模型可见四问：静态 prompt、工具描述与 provider wire 不变；固定前缀新增 0 token；KV 前缀不因该诊断变化；没有新注入项，只有上述有界哈希和数字日志。
