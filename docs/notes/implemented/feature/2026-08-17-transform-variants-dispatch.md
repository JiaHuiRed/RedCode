# transform.ts variants() 拆分：巨型 switch → 分派表 + provider 函数

日期：2026-08-17 · 状态：implemented · 来源：RedCode 瘦身审计第 1 项

## 问题

`provider/transform.ts` 的 `variants()` 函数 446 行，是一个嵌套 16 个 case 的巨型 switch：

- 每加一个模型/供应商，就要在 400 行的函数里找到对应 case 塞 if/else——这是审计里唯一「持续生长」的屎山（每加模型就膨胀，而其它大文件如 prompt.ts 是「大但稳定」）。
- 分支间大量重复形状：adaptive thinking（gateway/anthropic/sap 三处）、openai reasoningEffort+summary+include（copilot/azure/openai 三处）、thinking budget（gateway/bedrock/sap/anthropic 四处）各自手写。
- 6 组模型族特判（minimax-m3/glm/kimi/minimax 家族/grok-3-mini/grok）埋在 switch 之前，与 case 边界交错。

## 决策

拆成三层结构，行为零变化（131 个 variants 测试逐分支锚定）：

1. **模型族特判保留在入口**：glm/kimi/grok 按版本判定、minimax/k2p/qwen/big-pickle 整个家族排除——它们跨 provider 全局生效，逻辑上属于分派前的守卫。
2. **npm 分派表**：`variantProviders: Record<string, VariantFn>`，22 个 npm 包名 → 函数。共享实现的 provider 指向同一函数（cerebras/togetherai/xai/deepinfra/venice/openai-compatible → `openaiCompatVariants`；anthropic/google-vertex-anthropic → `anthropicVariants`；google/google-vertex → `googleVariants`；cohere/perplexity → `() => ({})`）。未知 npm 由 variants() 兜底返回 {}（原 switch default）。
3. **每 provider 一个函数**：15 个命名函数（openrouter/gateway-provider/ai-sdk-gateway/copilot/openai-compat/azure/openai/anthropic/bedrock/google/mistral/groq/sap + 2 个空实现）。决策注释（260729 GLM/kimi/grok、260802/260808 deepseek 双段、ai-gateway OAI 形状说明）原样搬进对应函数。
4. **形状工厂**：`openaiShapeVariants`（summary+include 三处复用）、`adaptiveThinkingVariants(efforts, display)`（display 仅 anthropic 带；gateway/sap 不带）、`fixedThinkingVariants`（16000/31999 固定，gateway/bedrock/sap）、`anthropicThinkingVariants(output)`（按 model.limit.output 动态折算，仅原生 anthropic）。

## 备选与否决理由

- **全量声明式数据表（DSL）**：把每个 provider 的规则变成 JSON 配置。否决——各分支依赖运行时计算（model.limit.output、release_date 版本门槛、providerID 特判），强行数据化要发明规则引擎，比原 switch 更复杂。分派表 + 函数是「数据化」的正确粒度：路由是数据（一行 npm→fn），规则是代码（每 provider 一个小函数）。
- **拆到独立文件**（transform/variants/ 子目录）：否决——helper（anthropicAdaptiveEfforts/googleThinkingLevelEfforts 等）跨文件引用面大，且 variants 只在 transform.ts 内部被 provider.ts 消费，单文件内组织足够。

## 后果

- variants() 主函数从 446 行 → ~80 行（守卫 + 特判 + 分派）；15 个 provider 函数每个 10-60 行，独立可读。
- 加新 provider：分派表加一行 + 写一个函数；加新模型：改对应 provider 的小函数，不碰公共骨架。
- 唯一 type 修复：mistralVariants 多分支返回导致 `{}` 推断为 `{ high?: undefined }`，加显式返回类型标注。
- 验证：typecheck 过；`-t variants` 131/131 全绿；全文件 224/225（1 fail 为既有 surrogate sanitization 问题，基线 3effb221 同样红，与本次无关）。