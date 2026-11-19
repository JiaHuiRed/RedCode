# GPT-6.2 缓存缺口：验证把固定指令放到 input 开头

状态为 proposed。2026-11-19 复核 RedSpace `21f8ad5e`、Codex `d1d1ba0b83`、OpenCode `88ca792e02`。**建议先在 RedSpace 的 Sol OAuth 路径做单变量 A/B。旧请求的缺口已有字段归因，新请求的 SDK 出站形状已离线验证，订阅端的回收量待测。** Astra 独立验收。工具声明另案评估。

## 两天的证据能回答什么

| 来源 | 观测 | 对本案的意义 |
| --- | --- | --- |
| RedSpace · Sol OAuth | 11 月 18 日暖轮总输入 35,826，读缓存 12,800，顶层指令 21,741 全部未命中，剩余未命中仅 1,285。另一组 63 秒续轮再次读回 12,800，顶层 21,860 全未命中 | 顶层指令解释了这两次暖轮的大部分缺口。128 请求长会话的未命中下限 21,846 与此吻合；长会话本身没有逐轮字段归因 |
| RedSpace · Astra OAuth | 暖轮总输入 35,827，整轮读缓存为 0，其中顶层指令 21,740，其余 14,087 | 还要证明历史能读到缓存。Sol 的暖轮结果和 92.5% 长上下文样例不能直接套给 Astra |
| OpenCode · Sol 公开 API | `#64542` 的录像向 `api.openai.com/v1/responses` 连发两次相同请求，`store:false`，首条 developer，工具为空。两次各 4,764 输入，首轮写 4,761、读 0，次轮读 4,761 | 证实这个形状能在该端点命中。录像未设顶层 instructions 对照，也未覆盖 OAuth 或有工具的追加历史 |
| Codex · 当前源码 | `#51156` 将基础指令移进历史。现版普通 Responses 可同时发送 developer 前缀与顶层 tools。自带模型目录的 6.1 与 6.2 Sol/Astra **均**启用 Responses Lite（`models.json` 逐条核验），客户端另发 Lite 专用头 | 有可借鉴的请求形状；Codex 的 6.1/6.2 全在 Lite 路由上，对普通端点上 6.1 为何全命中零参考；Lite 的命中率、工具协议和路由头不能当作 RedSpace 普通 OAuth 的实验结果 |

11 月 18 日的两组原始数值见[字段归因实测](2026-11-18-incremental-tool-declarations.md)和[归因诊断](../../implemented/feature/2026-11-18-cache-attribution-diagnostics.md)。6.1 长任务的高命中率用作健康参照；上下文大小、工具输出和冷轮占比都影响百分比。

公开 API 文档明确说明，GPT-6.2 把顶层 `instructions` 放在 `input` 后、可缓存断点之外；需要复用的指令应放在开头的 developer 消息。订阅 OAuth 有反例：同一 issue 的追加历史样本中，用户项命中 2,944、顶层指令命中 0；另一组几乎全是顶层指令的重复请求却读回 4,472 / 4,500，短 developer 变体也未改善。两种端点应分别取证。[OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [Codex OAuth issue #62109](https://github.com/openai/codex/issues/62109)

## 第一阶段的改动边界

1. **投递一份完整指令。** `packages/redspace/src/session/llm/request.ts` 的 `prepare` 先拼 agent、system、用户级指令，再运行 `experimental.chat.system.transform`。以旧路径变换后的 `system.join("\n")` 为基准，B 侧只在发送本次请求时前置一条 SDK system 消息，显式取 `systemMessageMode: "developer"`。最终 JSON 的 `input[0]` 应为 `{role:"developer",content:<原字符串>}`，顶层省略 `instructions`。插件可追加多个 system 块；沿用同一个 join 才能逐字对照。最终 options 还经过配置合并和 `chat.params`，须检查覆盖：若插件定制了指令或角色策略，保留原语义，避免同一份内容被双发或清空。
2. **按实际发送路径分流。** 先验证 `provider=openai`、OAuth、普通 Responses、wire 模型 `model.api.id=gpt-6.2-sol` 的 AI SDK 路径。Astra 同法单测后单独决定。API key、6.1、其他 provider 沿用现行选择。`llm.ts` 在 prepare **之后**才选择运行时，实验性 native 有 OAuth fetch 时可接管，遇到 provider-defined 工具又会回退到 AI SDK。native 的 `OpenAIResponses.lowerMessages` 把 system 写成 `role:"system"`，不读取 SDK 的角色选项。首版可在实际选中 AI SDK 后迁移；必须覆盖 native 真接管和回退两种情况。
3. **原会话的历史和工具由原逻辑管理。** developer 只属于这次出站投影，重试或续轮仍只发一份。无需写入会话库、msg-pin 或分配 `msg_` / `prt_` ID；SDK 路径在 `store:false` 时还会清理 input item 的 ID。`prefix-shape` 在 prepare 前比较装配段，不能证明最终 wire 形状。`request-evidence.ts` 已把 system/developer 归入 system，保留 wire 顺序。A/B 的 system 段哈希包含字段名和角色封装，改位置后会变化；在捕获的请求上另比正文 UTF-8 字节，并用段哈希检查各组自身是否稳定。
4. **按 RedSpace 的摘要行为验收。** OpenCode `#64542` 一度把专用 `/responses/compact` 的 system 留在顶层，`#64544` 随即改为同样前置 developer，并从返回的替换窗口滤去回显。RedSpace 的 `session/compaction.ts` 走 `processor.process → llm.stream` 普通生成。带快照的摘要复用原 agent/system/tools；无快照及 legacy 摘要按各自现有输入生成。覆盖三种摘要及压缩后首个普通请求，核对摘要可用、前缀只出现一份。按 agent 名识别摘要会漏掉快照路径。`c067fdae` 拆分的是性能基准用例。

**本地已验**：用本仓 `@ai-sdk/openai@4.0.59` 和 `ai.streamText`（`allowSystemInMessages:true`），以内存 fetch 读取实际序列化 JSON。Sol、Astra 均验证了 A 的顶层字段与 B 的 developer 正文逐字相同；移除这处差异后，工具、历史、`store:false` 和其余请求字段一致。B 追加 assistant/user 后原 input 仍是完整前缀，默认角色与显式 developer 在这两个模型上相同。这项检查没有调用模型。

## OAuth A/B 与上线判据

| 步骤 | 做法与判断 |
| --- | --- |
| 建两组会话 | A 从冷轮起始终用顶层指令；B 从冷轮起始终用 developer。使用同账号、端点、模型、effort/tier、工具表与确定性输入，各组维持自己的会话亲和与 cache key。在同一进程内短间隔交错运行，记请求间隔和实际 runtime，以新的成对会话交换启动顺序复测。首轮承担建缓存成本，单独记账 |
| 先复现再比较 | 使用与现场指令量级相当的稳定前缀。每组建议至少 3 次仅追加相同短后缀的暖轮，先固定回复 `OK`，再以相同短工具结果验证一次实际工具循环。串接真实输出；加密推理等不透明项按各组原样回放。核对各组前缀稳定、两组指令正文和工具等价。A 应重新出现接近 22k 的指令缺口 |
| 读数 | 按同一请求关联 `request.prefix`、`request.transport` 与 `request.provider-usage`，比较暖轮 `input_tokens − cached_tokens` 的中位数，并报告原始 input、cached、cache write（若提供）与取值范围。B 省略顶层字段后，归因缺失只表示未报告；在工具表等价、历史仅追加的前提下，以**整轮未命中下降**计收益。服务端未逐项归属的读数保留为未知 |
| 推进或撤回 | 建议的 Sol 试点线：两组成对复测均收回 A 顶层指令缺口的至少 80%（按 21.7k 约为 17.4k/暖轮），且工具执行、摘要及下一轮语义通过。HTTP 200、单次冷轮、或单独的“98%”不足以放量。若网关拒绝缺省顶层字段、A 未复现、B 持续零命中或收益未达线，记录状态码/数值，保留现有分派。Astra 需独立建立暖历史基线，再决定是否启用 |

实施时可复用 `packages/redspace/test/session/{llm,llm-native,request-evidence,compaction}.test.ts` 的请求捕获与摘要用例。发版记录列出最早改变的前缀位置、冷轮和暖轮的实际差值。若动态段（日期、Active Goal、插件输出）使稳定历史失去复用，再单独试稳定/动态指令分段或显式缓存断点；首个 A/B 沿用现有缓存模式。

## 模型可见变化与成本

- 正文来源、顺序、分隔符和工具定义沿用旧请求，变化是同一串指令的角色封装和在请求中的位置。角色封装及服务端排序会影响有效 token 数，记录实测差值。用固定指令控制一个可检查的回答或工具选择，核对角色优先级效果。
- 最早可见差异位于 input 首项。新旧形状切换时按冷轮核算，保留已测的稳态收益与压缩后首轮成本。无需重造 Codex 的 UUID、修改路由头或启用 Lite。
- 现场整段已超过 10k token（约 21.7k）。本次逐字迁移以隔离位置效应，截断会同时删减指令。`instruction_budget.max_total_bytes` 默认 64 KiB，约束指令来源；agent/user 与插件拼入以后，最终 join 没有同等的总字节上限。这是既有边界缺口，迁移不增加输入副本，完整前缀预算另行处理。

### 源码定位

- Codex `d1d1ba0b83`：`codex-rs/core/src/client.rs` 的 `build_responses_request` / `add_responses_lite_header`、`codex-rs/codex-api/src/common.rs` 的 `ResponsesApiRequest`、`codex-rs/models-manager/models.json`。增量工具的独立分派见 `codex-rs/core/src/session/step_context.rs` 的 `incremental_tools_feature`。
- OpenCode `88ca792e02`：`packages/ai/src/protocols/open-responses.ts` 的 `lowerConversation`、同目录 `utils/responses-compaction.ts`、`packages/ai/test/fixtures/recordings/openai-responses-cache/caches-the-system-prompt-on-gpt-6-2-sol.json`。提交依次为 `7ca7b3feba`（#64542）与 `de291ab7b1`（#64544）。
- RedSpace `21f8ad5e`：`packages/redspace/src/session/` 下的 `llm.ts`、`llm/request.ts`、`llm/native-runtime.ts`，最终 OAuth 传输在 `packages/redspace/src/plugin/codex.ts`，native 序列化在 `packages/llm/src/protocols/openai-responses.ts`。增量工具的适配与验收在[独立提案](2026-11-18-incremental-tool-declarations.md)。
