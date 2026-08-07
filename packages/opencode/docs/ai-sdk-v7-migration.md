# AI SDK v6 → v7 迁移清单

> 2026-08-06 调研。数据全部来自本仓实测（导入点扫描、models 缓存、会话库、v4/v5 沙箱探测），
> 不是照抄上游迁移指南。指南本身见 https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0

## 1. 真实影响面：只有一个 provider 包在跑

`package.json` 声明了约 20 个 `@ai-sdk/*` provider 包，但按 models 缓存实测，**本机实际会被加载的只有一个**：

| 在用的 provider | 解析到的包 |
| --- | --- |
| opencode-go（DeepSeek / MiMo 网关） | `@ai-sdk/openai-compatible` |
| deepseek（直连） | `@ai-sdk/openai-compatible` |
| stepfun / stepfun-step-plan | `@ai-sdk/openai-compatible` |
| xiaomi-token-plan-cn | `@ai-sdk/openai-compatible` |

**DeepSeek 没有自己的 SDK 包**，与其余国产模型一样走 openai-compatible。所以验证面 = `ai` + `@ai-sdk/openai-compatible` + 二者共同依赖的 `provider` / `provider-utils`。

anthropic / google / bedrock / mistral / cohere / groq 等十余个包在本机从不加载，正确性由 typecheck 保证即可，**不需要真实流量验证**。openrouter 走第三方 `@openrouter/ai-sdk-provider`，不在 ai-sdk 发布列车里，与本次升级无关（已在用户配置的 `disabled_providers` 中关闭）。

**但不能只升一部分**：provider 包与 `ai` 核心通过 `specificationVersion` 耦合（v6↔V3、v7↔V4）。留一个 v3 包在 v7 核心下，等于给"哪天有人选了 anthropic 模型"埋运行时雷。整族一起升，只是验证精力集中在 openai-compatible。

## 2. 导入点分类（core 31 + opencode 30 = 61）

### A 档 — 机械改名 / 纯类型，`npx @ai-sdk/codemod v7` 覆盖

- `JSONSchema7` 类型导入 —— `tool/json-schema.ts:1`、`tool/registry.ts:20`、`tool/tool.ts:2`、`provider/transform.ts:3`、`session/prompt.ts:12`
- 错误类 —— `provider/error.ts:1`、`acp/agent.ts:49`、`session/message-v2.ts:4`、`provider/provider.ts:5`
- 工具与消息类型 —— `mcp/index.ts:1`、`session/prompt.ts:11`、`session/llm/request.ts:12`、`session/llm/native-runtime.ts:6`、`session/llm/native-request.ts:12`、`provider/transform.ts:1`

假警报：全仓 9 处 `stepCountIs` 是 `packages/llm` 自己导出的同名函数，与 SDK 无关，**不要改**。

### B 档 — 必须人工核对（语义变了，codemod 帮不上），共 4 处

| 位置 | 变化 | 风险 |
| --- | --- | --- |
| **`session/llm/ai-sdk.ts`** | 顶层 `usage`/`toolCalls`/`content` 改为**跨步骤聚合**；`providerMetadata`/`reasoning`/`response` 移入 `finalStep` | **最高**。该文件把 SDK 流转成 `LLMEvent`，是 token 记账与缓存命中统计的唯一入口。DeepSeek 的 cache miss/write/hit 三档计费、状态栏 Turn/Conn/Hit 三个指标全依赖它 |
| `session/message-v2.ts` | `{type:"image"}` → `{type:"file", mediaType}`；工具结果的 `image-*`/`file-*` 变体合并为单一 `file` | vision 附件链路，全仓 30 处 `type: "image"` |
| `session/llm.ts:356` | `experimental_telemetry` → `telemetry`；OpenTelemetry 拆到独立包 `@ai-sdk/otel`，改用 `registerTelemetry()`；遥测由 opt-in 变 opt-out | 牵动对外配置项 `experimental.openTelemetry`（`config.ts:313` 有文档描述） |
| `session/llm.ts:7,340,396,487,521` | `system` → `instructions`；`.fullStream` → `.stream`；中间件 `specificationVersion: "v3"` 需实测 v7 是否仍接受 | 主调用点，漏一处即全线不可用 |

其余零散：`agent/agent.ts:5` 的 `experimental_output` → `output`（全仓 6 处）。

### C 档 — 内嵌 GitHub Copilot provider：只有 6 处改名

`packages/core/src/github-copilot/` 是一份 vendored 的完整 openai-compatible provider（chat + responses + 6 个工具工厂），直接实现 spec 接口。**沙箱实测 v4/v5 的符号存活情况：用到的 16 个符号里 14 个原样保留**（`LanguageModelV3` 及配套类型、`convertToBase64`、`parseProviderOptions`、`withUserAgentSuffix` 等全在）。

只有两个工厂函数改了名，分布在 6 个工具文件里：

```
createProviderDefinedToolFactory        → createProviderToolFactory
createProviderDefinedToolFactoryWithOutputSchema → createProviderToolFactoryWithOutputSchema
```

> 260807 修正：此表方向曾写反（写成 v6 无 Defined → v7 加 Defined）。实测 provider-utils 4.0.21~4.0.30 全部只导出**无 Defined** 的 `createProviderToolFactory(WithOutputSchema)`，v6→v7 是**去掉** Defined。对应 4 个工具文件（local-shell/image-generation/code-interpreter/file-search）已在 260807 改回无 Defined 版本。

Copilot 在本机同样从不加载，typecheck 过即可，无需流量验证。

## 3. 额外债务

`patches/@ai-sdk%2Fxai@3.0.82.patch`（99 行）给 xai responses 的输入转换补了 PDF `input_file` 支持，按 hash 钉死在 3.0.82 的 `dist/index.js`，**4.x 必然打不上**。升级前先查上游 4.x 是否已原生支持；没有就重做补丁。

## 4. 执行顺序

1. 开分支，整族升 `ai` + 全部 `@ai-sdk/*`（同一发布列车，不能只升一半）
2. `npx @ai-sdk/codemod v7` 收 A 档
3. typecheck 收敛 C 档与残余类型错误
4. 人工只盯 B 档那 4 处
5. 处理 xai 补丁
6. 验证（全部用 DeepSeek，它就是 openai-compatible 的代表）：
   - 一轮多步工具调用会话，**比对升级前后的 `tokens.cache.read/miss/write` 三个数**与状态栏 Turn/Conn/Hit
   - 一次 vision 附件（截图）调用
   - 一次压缩触发，确认 usage 聚合语义没把统计打歪
   - `redcode mcp list` 全绿（工具定义序列化路径）

## 5. 回退与风险

升级只动 `package.json` 与代码，不动数据；分支上做，任何一步不对 `git checkout` 即可。

真正的风险不是"跑不起来"，而是**记账数字悄悄偏移且不报错**。第 6 步的数字比对必须做，不能靠"跑起来没崩"判断成功。
