# 增量工具声明:把工具表从每轮固定成本变成一次声明

状态:proposed(待拍板,2026-11-18)

## 问题

`gpt-6.2-sol` 上出现每轮固定 22k token 的未命中,与上下文大小无关,导致单次命中率被钉在 92.5% 左右上不去。

实测(会话 `ses_ffe5e132b979fffeP4tzfE4qNlFNiR`,同一会话内连续切换模型):

| 阶段 | 请求数 | 每请求未命中 |
| --- | --- | --- |
| gpt-6.2-sol | 128 | 平均 23,899,除首轮外最小 21,846 |
| gpt-6.1-terra(切模型后) | 13 | 117 / 219 / 246 起,大工具结果轮 3,810～7,028 |

- 该缺口**不随上下文变化**:上下文 36k 时未命中 22.8k,270k 时 22.4k(占比从 63% 降到 8%)。
- `gap = cache.read − 上一轮 total` 在 6.2-sol 上恒为 −22k 左右,切 terra 后变成 +12 / −36 / −37。
- 稳态上限 = `270k / (270k + 22k) ≈ 92.5%`,与侧栏 Turn 91.3% 吻合——**它已经收敛了,只是收敛点被这 22k 压低**。

量级对得上工具表:`prompt-pin` 快照实测 71 个工具 = **17,127 token**(MCP 50 个 9,858 + 内置 21 个 7,269,`estimateReporting` 口径,不含 SDK 层的 `parameters`/`$schema` 包装)。

归属已经排除 RedCode 装配:

- 同工作区、同 71 工具、同版本下 `gpt-6.1-terra` 每请求只丢 2,085(184 请求)。
- `prefix-shape` 的 system/tools hash 在整段会话里没有报过一次变化。
- `models.dev` 里 6.1-sol 与 6.2-sol 的 catalog 键集合完全一致,`GPT6_FAMILY_RE` 对两者命中同一分支。

**结论:6.2-sol 端点不缓存顶层 `tools` 段,RedCode 每轮替它重付一次整张工具表。**

Codex 侧的同型证据(400 commit 内,`55897425e8` #59832 原文):

> Incremental tool declarations were limited to Responses Lite. **Regular OpenAI Responses requests sent the full current tool catalog on each request.**

他们的改法是把工具声明放进对话历史、变更时追加,并明确要求 "preserving existing history prefixes",测试里断言 "incremental requests preserve input prefixes"。三个 feature flag 现在都是 `Stable` + `default_enabled: true`。

## 目标

1. 顶层 `tools` 不再每轮随请求重发,减少固定前缀。
2. 让"不缓存顶层 tools"的模型(6.2-sol 这类)也能吃到历史前缀缓存。
3. 顺带为所有模型去掉一块固定成本(system+tools 之外,工具表是目前最大的一块)。

## 非目标

- **不改工具执行语义**:`tool.execute`、权限、审批、`sortedTools` 执行路径全部不动。
- **不为 chat completions 实现**:`openai-compatible` 没有输入项声明能力,保持顶层 tools。
- **不再继续 gate 低频工具**:已量化评估,按 30 天调用 <30 次可 gate 的 MCP 工具只有 15 个、合计 3,144 token(18%)。而激活会改变顶层 tools、打掉一次完整前缀重建(healthy 模型约 262k),平衡点约 84 轮,典型任务净亏。工具面瘦身已经吃到头。

## 方案

### A(主):工具声明进 input

对齐 Codex #59832:

- 首轮把全量工具声明作为 `input` 的一段落发出;后续请求只追加**变化**的声明(新增/移除/签名变更)。
- 顶层 `tools` 只保留 hosted 工具(如 `web_search` 一类),普通 function 声明全部走历史。
- 声明内容沿用现有稳定性保障:`PromptCaches.tools` + `overlayToolDefs`(首轮定义钉死),声明本身按 `toolsHash` 去重。

待验证的字段名:`additional_tools`(来自 Codex commit 措辞 "Keep hosted `web_search` configuration in top-level `tools` rather than `additional_tools`")。**是否对 API key 用户开放、`store: false` 下是否可用,是第 0 步要回答的问题。**

### B(备选):改用 OpenAI hosted `tool_search`

`@ai-sdk/openai` 4.0.59 已带 `toolSearchToolFactory` 与 `tool_search_call` / `tool_search_output` chunk 类型,说明服务端有原生工具检索。若它在 `store: false` + API key 下可用,可把自建 `search_tools`(gated 机制)映射过去:**工具目录由服务端管理,客户端顶层 tools 天然稳定**,前缀不受工具启用影响。

比 A 轻一个量级,但同样卡在"服务端是否愿意在无状态请求里保存工具目录"。

### C(否决):继续按频率 gate 工具

省 3.1k/轮,换一次 262k 重建,平衡点 84 轮,且 `search_tools` 30 天全库只被调用 18 次——gate 后低频工具事实不可用。**收益与代价直接对冲,不做。**

## 改动点

按依赖顺序,前两层不通则不进入业务改造。

| # | 层 | 位置 | 内容 |
| --- | --- | --- | --- |
| 0 | 协议验证 | `.redcode/temp/` 一次性脚本 | 直连 `/v1/responses` 发声明项,拿 200/400 与 `cached_tokens` |
| 1 | 出站通道 | `session/llm.ts`、`provider/transform.ts` | AI SDK 的 `ModelMessage` 不接受自定义 input item,需升级 SDK / provider 请求钩子 / fetch 层改写三选一 |
| 2 | 组装层 | `session/prompt.ts:1884-1930, 2492-2518` | `sortedTools` 拆成执行集与声明集;首轮全量、后续差异 |
| 3 | 历史投影 | `session/message-v2.ts` (`toModelMessages` / `stitchModelMessages`) | 声明成为历史序列的一部分;切片边界含声明项;`toolsHash` 去重不重复追加 |
| 4 | 压缩 | `session/compaction.ts` | 压缩重写历史时声明必须保留或重建(Codex 专门覆盖 compaction) |
| 5 | 切模型 | `session/prompt-caches.ts:71` | `tools` 缓存当前 model-agnostic,切模型后声明要作废重发 |
| 6 | provider 分流 | `provider/transform.ts` | 只对 `@ai-sdk/openai`(Responses)启用,加开关 |
| 7 | 门禁 | `session/prefix-shape.ts` | 诊断升级为断言:声明追加后前缀不变;补"增量声明"用例 |

## 验证计划

**第 0 步(半天,决定后面全部)**:写一个最小脚本,两轮请求对比:

1. 第一轮:顶层 `tools` 全量 + 历史 N 条。
2. 第二轮:顶层 `tools` 只留 hosted,声明走 `input`,历史 append 若干。
3. 断言第二轮 `cached_tokens` 覆盖历史(而不是从声明处断开)。

跑法:key 从 `data/auth.json` 读,不落盘、不打印;脚本放 `.redcode/temp/`,结论回写本 note。

**门槛**:若 400(字段不存在/不支持)或 `store: false` 下声明不计入缓存,本方案整体作废,回到 6.1 家族。

## 风险与取舍

- **API 未开放(最大)**:`additional_tools` 可能只对 ChatGPT 后端(Responses Lite)开放,API key 用户拿不到。第 0 步就是为了尽早知道。
- **SDK 卡点**:`@ai-sdk/openai` 4.0.59 无该序列化路径。拦截 fetch 可行但维护成本高(每次升级要核对请求体形状)。
- **边界复杂度**:压缩、切模型、子代理继承(现有 `cacheKey = parentSessionID ?? sessionID`)三处都要覆盖,漏一处就会出现"声明与工具集不一致"的静默错。
- **收益面窄**:只对 `openai` provider 生效。其它 provider 的 tools 本来命中,无收益。

## 工作量

3～5 天:第 0 步 0.5 天;出站通道 1～2 天;历史/压缩/切模型 1～2 天;门禁与回归 0.5 天。

## 后果

- **做成**:6.2-sol 的每轮 22k 降到 0～2k,单次命中率上限从 92.5% 回到 99% 档;所有模型顶层 tools 从 17.1k 固定成本降为一次性声明。
- **做不成**:维持现状,日常用 6.1 家族(terra/sol),6.2-sol 标记为"缓存有缺陷,等 `last_updated` 再试"。

## 落地时的回链要求

- CHANGELOG 条目回链本 note。
- `session/prompt.ts` 声明组装处、`provider/transform.ts` 分流处加头注释回链。
- 模型可见内容变化(工具声明位置从顶层移入历史),按根 AGENTS"模型可见改动四问"逐条回答:看到什么变了 / token 影响 / KV cache 影响(首轮一次性重建,之后前缀稳定) / 注入项硬上限(声明总量需有上限,建议复用 `PromptCaches.tools` 的会话级定义,不再新增无界写入)。
