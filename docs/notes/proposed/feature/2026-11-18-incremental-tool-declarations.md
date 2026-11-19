# 增量工具声明：评估工具表变更后能否复用历史前缀

状态:proposed(待拍板,2026-11-18)

## 问题

这段 `gpt-6.2-sol` 长会话在不同上下文长度上均出现约 22k token 的未命中。固定缺口占当前输入的比例随上下文长度而变。

实测(会话 `ses_ffe5e132b979fffeP4tzfE4qNlFNiR`,同一会话内连续切换模型):

| 阶段 | 请求数 | 每请求未命中 |
| --- | --- | --- |
| gpt-6.2-sol | 128 | 平均 23,899,除首轮外最小 21,846 |
| gpt-6.1-terra(切模型后) | 13 | 117 / 219 / 246 起,大工具结果轮 3,810～7,028 |

- 该缺口**不随上下文变化**:上下文 36k 时未命中 22.8k,270k 时 22.4k(占比从 63% 降到 8%)。
- `gap = cache.read − 上一轮 total` 在 6.2-sol 上恒为 −22k 左右,切 terra 后变成 +12 / −36 / −37。
- 若一轮已命中 270k，另有 22k 未命中，命中率约为 92.5%。这是给定输入规模下的算例；现场侧栏 Turn 为 91.3%。

量级对得上工具表:`prompt-pin` 快照实测 71 个工具 = **17,127 token**(MCP 50 个 9,858 + 内置 21 个 7,269,`estimateReporting` 口径,不含 SDK 层的 `parameters`/`$schema` 包装)。

以下观测支持本地组装内容稳定，字段归属见下一节。

- 同工作区、同 71 工具、同版本下 `gpt-6.1-terra` 每请求只丢 2,085(184 请求)。
- `prefix-shape` 的 system/tools hash 在整段会话里没有报过一次变化。
- `models.dev` 里 6.1-sol 与 6.2-sol 的 catalog 键集合完全一致,`GPT6_FAMILY_RE` 对两者命中同一分支。

**结论（2026-11-18 上午，已被同日晚的字段归因实测修正）:当时只有本地 `prefix-shape` 观测，把 22k 缺口归到顶层 `tools`。字段归因显示缺口主体是 `instructions`——见下方「字段归因实测」。工具表布局的净收益需单独测量。**

## 字段归因实测

**2026-11-18 晚**，在 `2b02a501` 上用 `redcode run` 各开两个独立标题会话，`variant=low`，只回复 `OK`，
无工具调用、无标题生成；同一会话内两轮（冷启动 + 续轮）：

| 模型 | 轮次 | input | cached | uncached | instructions 总量 / 命中 | unattributed |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| gpt-6.2-sol | 1 | 35,743 | 0 | 35,743 | 21,741 / 0 | 14,002 |
| gpt-6.2-sol | 2 | 35,826 | 12,800 | 23,026 | 21,741 / 0 | 1,285 |
| gpt-6.2-astra | 1 | 35,742 | 0 | 35,742 | 21,740 / 0 | 14,002 |
| gpt-6.2-astra | 2 | 35,827 | 0 | 35,827 | 21,740 / 0 | 14,087 |

两轮之间 `system` 与 `tools` 段哈希完全一致（tools `11be3695…`、count 66、length 71,431；
system 分别为 `76d1fc72…` / `93ed8e50…`）。因此：

- **两个 6.2 在本次都表现为顶层指令全未命中**，且缺口量级与 22k 固定未命中吻合。
- Sol 第二轮在指令以外读到 12,800。Astra 第二轮间隔 44 秒，整轮读数为 0；该样本无法区分其余 14,087 未命中的原因。
- 样本只有两轮，不能推断长期行为、族级策略或服务端规则；`unattributedInputTokens` 仍不自动归给工具表。

原始数值另存本机临时证据：`.redcode/temp/cache-probe-6.2sol-20261118.json`、
`.redcode/temp/cache-probe-6.2astra-20261118.json`（临时产物，随目录清理；本表是长期副本）。

## 第二次实测（0.19.3 `a4b3ef5b`，2026-11-18 深夜）

同 session 三次 `redcode run`（`--title` 建会话 → `--session` 续接），`variant=low`，prompt 固定只回 `OK`，无工具调用。第二次运行前在父 shell 预设 `REDCODE_LOG_INITIALIZED_RUN_ID=REDCODE_RUN_ID`，避免 `dev.log` 被下一进程截断（`core/src/util/log.ts:75`）。

| 轮 | 距上轮 | input | cached | instructions 命中 | 未归属 |
| --- | --- | ---: | ---: | --- | ---: |
| cold | — | 35,826 | 0 | 0 / 21,860 | 13,966 |
| warm | 63 秒 | 35,905 | 12,800 | 0 / 21,860 | 1,245 |
| warm（意外续跑） | 5 分 9 秒 | 35,984 | 0 | 0 / 21,860 | 14,124 |

`tools` 段 sha256 `11be3695…`、count 66、length 71,431，与 0.19.2 那次完全一致；warm 轮 `cached=12,800` 也与上次 Sol 第二轮相同，条件一致性充分。

三条判定：

1. **两组短探针的顶层指令全量未命中。** 长会话每请求未命中下限 21,846，与此处 21,860 相差 14；长会话只有总量，逐轮的字段归属及 turn-state 的单独影响仍需对照。
2. **turn-state 在请求侧从未回传，且是机制决定。** `plugin/codex.ts:479-484` 的令牌只存在进程内 Map，仅同进程第二个及以后请求才回写 header。每次 `redcode run` 是独立进程且单请求，不可能携带。因此「Astra 已回传，故排除漏传请求头」这个方向不成立（前提不可能发生）；同文件响应侧的 `turnStateHash` 是服务端下发，不能当作请求侧回传。
3. **整轮零命中应记录间隔。** 第三轮间隔 5 分 9 秒后读缓存为 0；Astra 的 44 秒续轮也出现过整轮为 0。这两次读数没有给出订阅端缓存失效的原因或 TTL。

**对本提案的影响**：11 月 18 日记录的暖轮大头在顶层指令。11 月 19 日补充了可独立验证的[固定指令投递方案](2026-11-19-instructions-developer-prefix.md)。本案只评估工具声明布局本身的收益。

原始探针当时写入 `.redcode/temp/cache-probe-6.2sol-20261118-2313.json`，长期保留的数值以上表为准。

**Codex 的路由边界（11 月 19 日复核）**。`55897425e8`（#59832）曾为普通 Responses 增加可选的增量工具，后续 `762f87d5bb`（#60040）收窄了适用范围。`d1d1ba0b83` 的 `codex-rs/core/src/session/step_context.rs::incremental_tools_feature` 只为 Lite、Bedrock、GCP 选择对应开关。普通 OpenAI 路径仍可把完整工具表放顶层，同时把固定指令放进 developer 消息。功能标为 Stable 不能代替目标端点验证。

## 目标

1. 评估工具表变化时，追加声明能否保留既有历史前缀，并保持工具可用性。
2. 按目标路由量化实际输入、缓存读写与请求体大小。17,127 token 是本地工具表估算；`store:false` 下回放完整历史仍会携带旧声明，不能按每轮节省整张表预算。

## 非目标

- **不改工具执行语义**:`tool.execute`、权限、审批、`sortedTools` 执行路径全部不动。
- **不为 chat completions 实现**:`openai-compatible` 没有输入项声明能力,保持顶层 tools。
- **不再继续 gate 低频工具**:已量化评估,按 30 天调用 <30 次可 gate 的 MCP 工具只有 15 个、合计 3,144 token(18%)。而激活会改变顶层 tools、打掉一次完整前缀重建(healthy 模型约 262k),平衡点约 84 轮,典型任务净亏。工具面瘦身已经吃到头。

## 方案

### A(主):工具声明进 input

候选布局沿用 Codex 的历史追加方式：

- 首轮把工具声明放进 `input`，续轮回放旧声明，只把变化追加在后。新增、签名更新与撤销分别验证；历史声明可见时，当前执行权限仍由本地工具集裁决。
- 顶层 `tools` 只保留 hosted 工具(如 `web_search` 一类),普通 function 声明全部走历史。
- 声明内容沿用现有稳定性保障:`PromptCaches.tools` + `overlayToolDefs`(首轮定义钉死),声明本身按 `toolsHash` 去重。

候选 input item 类型为 `additional_tools`。对实际使用的端点、认证方式和 `store:false` 单独验证接受、工具调用和缓存行为。

### B(备选):改用 OpenAI hosted `tool_search`

`@ai-sdk/openai` 4.0.59 带有 `toolSearchToolFactory` 与 `tool_search_call` / `tool_search_output` 类型。公开 Responses API 的 hosted 路径在顶层声明 `tool_search`，对函数或 MCP 标记 `defer_loading:true`，检索命中后才把定义载入上下文。评估其对 `search_tools` 的替代时，分别量化请求体大小、模型输入和实际工具调用；订阅端支持另测。[OpenAI Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)

### C(否决):继续按频率 gate 工具

省 3.1k/轮,换一次 262k 重建,平衡点 84 轮,且 `search_tools` 30 天全库只被调用 18 次——gate 后低频工具事实不可用。**收益与代价直接对冲,不做。**

## 改动点

按依赖顺序,前两层不通则不进入业务改造。

| # | 层 | 位置 | 内容 |
| --- | --- | --- | --- |
| 0 | 协议验证 | `.redcode/temp/` 一次性脚本 | 在实际目标端点测声明接受、指定工具的调用/返回以及续轮缓存读数 |
| 1 | 出站通道 | `session/llm.ts`、`provider/transform.ts` | AI SDK 的 `ModelMessage` 不接受自定义 input item,需升级 SDK / provider 请求钩子 / fetch 层改写三选一 |
| 2 | 组装层 | `session/prompt.ts:1884-1930, 2492-2518` | `sortedTools` 拆成执行集与声明集;首轮全量、后续差异 |
| 3 | 历史投影 | `session/message-v2.ts` (`toModelMessages` / `stitchModelMessages`) | 声明成为历史序列的一部分;切片边界含声明项;`toolsHash` 去重不重复追加 |
| 4 | 压缩 | `session/compaction.ts` | 压缩重写历史时声明必须保留或重建(Codex 专门覆盖 compaction) |
| 5 | 切模型 | `session/prompt-caches.ts:71` | `tools` 缓存当前 model-agnostic,切模型后声明要作废重发 |
| 6 | provider 分流 | `provider/transform.ts` | 只对 `@ai-sdk/openai`(Responses)启用,加开关 |
| 7 | 门禁 | `session/prefix-shape.ts` | 诊断升级为断言:声明追加后前缀不变;补"增量声明"用例 |

## 验证计划

A 组从冷轮起使用顶层工具表；B 组从冷轮起使用 `additional_tools` 历史项。各组独立预热，指令位置、工具定义、认证、模型、`store:false` 与追加的任务相同。分别验证首轮声明的工具能调用、续轮新增的工具能调用、撤销后的工具无法执行，再对照变更前后的历史命中与请求体大小。若字段被拒、工具不可用或缓存无收益，仅停止相应路由上的增量工具试验。固定指令的试验继续使用原顶层工具表。

## 风险与取舍

- **协议适用范围**：公开 API 已描述 `additional_tools`，Codex 的普通 OpenAI 分派仍未启用增量工具。文档中的类型、当前客户端选择和目标 OAuth 端点的实际接受度是三项不同证据。[OpenAI input items](https://developers.openai.com/api/reference/resources/responses/subresources/input_items/methods/list)
- **SDK 卡点**:`@ai-sdk/openai` 4.0.59 无该序列化路径。拦截 fetch 可行但维护成本高(每次升级要核对请求体形状)。
- **边界复杂度**:压缩、切模型、子代理继承(现有 `cacheKey = parentSessionID ?? sessionID`)三处都要覆盖,漏一处就会出现"声明与工具集不一致"的静默错。
- **收益范围**：仅对完成测试的端点与工具变更模式报告收益。顶层工具表在旧请求里已能复用多少，以同组基线计量。

## 工作量

3～5 天:第 0 步 0.5 天;出站通道 1～2 天;历史/压缩/切模型 1～2 天;门禁与回归 0.5 天。

## 后果

- 试验通过后，只在相应路由上使用经过验收的工具布局，记录暖轮和工具变化轮的净收益。
- 试验未通过时继续发送顶层工具表。6.2 固定指令缺口有独立的方案和验收条件。

## 落地时的回链要求

- CHANGELOG 条目回链本 note。
- `session/prompt.ts` 声明组装处、`provider/transform.ts` 分流处加头注释回链。
- 模型可见内容变化(工具声明位置从顶层移入历史),按根 AGENTS"模型可见改动四问"逐条回答:看到什么变了 / token 影响 / KV cache 影响(首轮一次性重建,之后前缀稳定) / 注入项硬上限(声明总量需有上限,建议复用 `PromptCaches.tools` 的会话级定义,不再新增无界写入)。

## 相关

- [6.2 固定指令的 developer 前缀方案](2026-11-19-instructions-developer-prefix.md)先固定工具表，独立验证 Sol 与 Astra 的 OAuth 暖轮。
