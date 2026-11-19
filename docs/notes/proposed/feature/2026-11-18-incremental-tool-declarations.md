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

**结论（2026-11-18 上午，已被同日晚的字段归因实测修正）:当时只有本地 `prefix-shape` 观测，把 22k 缺口归到顶层 `tools`。字段归因显示缺口主体是 `instructions`——见下方「字段归因实测」。本提案的工具表改动仍有独立价值（去掉一块固定成本），但不能当作 instructions 缺口的已证实修法。**

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
- Sol 第二轮的其它部分命中了 12,800；Astra 第二轮连历史部分也未命中。两者不能合并成同一根因（Astra 两轮间隔仅 44 秒，不是缓存过期）。
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

1. **缺口就是 instructions 全量。** 128 轮会话的每请求未命中下限 21,846，与本轮 instructions 21,860 只差 14。那种会话有工具调用、同进程多请求、turn-state 已回传，缺口仍在——**缺口与轮次、与 turn-state 都无关**，就是 instructions 段每轮全 miss。
2. **turn-state 在请求侧从未回传，且是机制决定。** `plugin/codex.ts:479-484` 的令牌只存在进程内 Map，仅同进程第二个及以后请求才回写 header。每次 `redcode run` 是独立进程且单请求，不可能携带。因此「Astra 已回传，故排除漏传请求头」这个方向不成立（前提不可能发生）；同文件响应侧的 `turnStateHash` 是服务端下发，不能当作请求侧回传。
3. **零命中必须先看间隔。** 第三轮距第二轮 5 分 9 秒、payload 几乎没变，cached 归 0，与 prompt cache 不活跃 TTL（约 5 分钟）一致（未直接验证服务端 TTL 配置）。以后任何「整轮零命中」结论都要先记两请求间隔。

**对本提案的影响**：工具表改动救不了 6.2-sol 的 22k 缺口——缺口在 instructions 段，不在顶层 `tools`。方案 A/B 仍有独立价值（去掉一块固定成本），但不能当作这个缺口的修法。6.2-sol 的本地可控杠杆只剩**压缩 instructions 体积**，或等模型更新；日常继续用 6.1 家族（同工作区 `gpt-6.1-sol` 的 instructions 22,053 全命中）。

原始数值：`.redcode/temp/cache-probe-6.2sol-20261118-2313.json`（含 `headerHashes` 原文，长期副本）。

Codex 侧的同型证据(400 commit 内,`55897425e8` #59832 原文):

> Incremental tool declarations were limited to Responses Lite. **Regular OpenAI Responses requests sent the full current tool catalog on each request.**

他们的改法是把工具声明放进对话历史、变更时追加,并明确要求 "preserving existing history prefixes",测试里断言 "incremental requests preserve input prefixes"。三个 feature flag 现在都是 `Stable` + `default_enabled: true`。

## 目标

1. 顶层 `tools` 不再每轮随请求重发,减少固定前缀。
2. 让顶层 `tools` 也进入可缓存的历史前缀，而不是每轮重发的固定成本。
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

- **做成**:所有模型顶层 `tools` 从 17.1k 固定成本降为一次性声明;命中率上限在原基础上抬升。**6.2-sol 的 22k 缺口不受影响**——那是 instructions 段的每轮全 miss,本方案动不到。~~仍需另解(压缩 instructions 体积,或等模型更新)~~ **261119 已定位根因并给出第三条路**:缺口根因是顶层 `instructions` 字段不在 6.2 缓存路径上(input 数组才在),修法 = 固定指令改走 input 前缀 developer message,与 本 note 的 tools 声明合并实施即为 Codex Responses Lite 完整形态 → `2026-11-19-instructions-developer-prefix.md`。
- **做不成**:维持现状,日常用 6.1 家族(terra/sol),6.2-sol 标记为"instructions 段不缓存,等 `last_updated` 再试"。

## 落地时的回链要求

- CHANGELOG 条目回链本 note。
- `session/prompt.ts` 声明组装处、`provider/transform.ts` 分流处加头注释回链。
- 模型可见内容变化(工具声明位置从顶层移入历史),按根 AGENTS"模型可见改动四问"逐条回答:看到什么变了 / token 影响 / KV cache 影响(首轮一次性重建,之后前缀稳定) / 注入项硬上限(声明总量需有上限,建议复用 `PromptCaches.tools` 的会话级定义,不再新增无界写入)。

## 相关

- instructions 缓存缺口根因与 developer message 前缀方案(261119 调研定案):`docs/notes/proposed/feature/2026-11-19-instructions-developer-prefix.md`——本 note 的 tools 声明与它的 developer 前缀共享同一硬门槛实测。
