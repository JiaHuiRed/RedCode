# ZCode（智谱官方 harness）提示词架构与 GLM 模型优化审查

状态:proposed

## 结论

ZCode 与 RedCode 的**分层位置相反**，但两边都做实测校准：

- **ZCode**：提示词**只有一份、与模型完全无关**；所有模型适配下沉到**声明式 JSON 模型目录**（`config/provider/zcode-builtin.json`，6,391 行，用 `modelMatch` 正则 + Restricted CEL 表达式映射请求体）。
- **RedCode**：提示词**按模型切 16 支**（`system.ts:63-121`）；参数适配写在 **TS 代码**里（`provider/transform.ts`）。

ZCode 单份提示词不是"更先进"，而是**它只服务智谱自家模型**；RedCode 的按模型 delta 是实测驱动（step 过思考、deepseek-flash 缺深度），前提不同，不能直接照搬。**登记为参考候选的是「模型适配声明式化」与「工具边界纪律」两条（§六），是否采纳按 RedCode 自己的判据过，本文不替它下结论。**

另有一处**两仓对 GLM-5.3 推理档位的定义不一致**，见 §五。

## 一、提示词架构

### 1.1 三条 system 消息 + 缓存分段

`core/src/context/builder.ts:234-280` 把系统提示词拆成**三条独立的 `role: "system"` 消息**，各自带缓存标记：

| 位置 | 内容 | 缓存标记 |
| --- | --- | --- |
| `system[0]` | CLI prefix：`You are ZCode, an interactive coding agent` | **无**（契约明写 "carries no cache marker"） |
| `system[1]` | static/global-cache body（身份 + 安全边界 + `# Harness`） | ephemeral |
| `system[2]` | dynamic/org-cache body（沟通风格、session guidance、memory、env、output style、context management、gitStatus） | ephemeral |

设计意图写在 `docs/design/v2/loop/system-prompt-contract.md`：**"keep the static/global-cache body separate from the dynamic/org-cache body"**。契约里还提到**四个断点的预算**（"leaves room for the existing conversation-tail cache marker within the provider's four-breakpoint limit"）——分段数量是按 provider 的缓存断点上限倒推的，不是随便切的。

每个 section 自带左边界：stable 块以 `\n` 开头，dynamic 块以 `\n\n` 开头；OpenAI 兼容适配器只做拼接、**不推断空白**。

### 1.2 工具边界：明确禁止把工具 schema 镜像进提示词

`builder.ts:49-53` 的 `setToolRegistry` 是 **no-op**，注释直说：

> 工具说明由 model request 的 tools 字段承载，不再镜像进 system prompt。

契约文档的 **Tool Boundary** 一节把这条写成硬约束：

- **Allowed**：`Prefer fast repository search and direct file reads before editing.`
- **Disallowed**：`Reprinting full tool schema fields in the stable prompt.` / `Maintaining a separate list of all available tools in the stable prompt.`

即：提示词可以讲**工具使用哲学**，但不能出现工具名清单、JSON schema、权限元数据。

**与 RedCode 的对照**：RedCode 的 `default.md` 有 `# Tools` 段（`default.md:55-64`），另有 25 个 `tool/*.md`（25,848 字节）作为工具描述。ZCode 的工具描述走 provider 的 `tools` 字段，实测 `description` 字面量约 5,380 字符（27 处，正则粗测，偏低估）——**比 RedCode 精简得多，且与提示词物理分离**。

### 1.3 提示词不按模型分支

全仓提示词装配里**唯一的模型引用**是 `env-info.ts:78` 的一行事实陈述：

```
- You are powered by the model named ${model.providerId}/${model.modelId}.
```

没有任何 `if (model.includes(...))` 式的提示词分支。

**与 RedCode 的对照**：`system.ts:63-121` 有 16 条分支——6 条 `withDefaultPrompt`（叠加 default.md）+ 10 条独立全量文件。ZCode 的等价物是**零分支 + 富模型目录**。

### 1.4 稳定段与动态段的内容

**`system[1]`（static，契约规定到最后一个 `# Harness` 条目结束）**：

1. 无标题的 ZCode 软件工程 agent 简介
2. 授权安全边界（`SECURITY_NOTICE`：允许防御性安全/CTF/教育，拒绝破坏性技术/DoS/大规模攻击/供应链投毒/规避检测，双用途工具需明确授权语境）
3. `# Harness` 段——终端 markdown 渲染、权限拒绝即用户否决（调整而非原样重试）、MCS/hook 反馈语义、优先用专用文件/搜索工具、独立调用并行、`file_path:line_number` 可点击

契约明确：**`system[1]` 里不许出现 `# Agent Identity` / `# Task Behavior` / `# Risky Actions` / `# Communication Style` 这些标题**——旧的四段结构已被废弃合并。

**`system[2]`（dynamic）**，固定顺序：

1. `# Communicating with the user` —— 最长的一段，讲的是**输出可读性**：为"离开一会儿回来的同事"写；回合最后一条消息必须承载全部结论；先给结果（TLDR）；**"readable 比 concise 重要"**——短靠"选材"不靠"压缩成碎片/缩写/箭头链"；答案形状匹配问题形状
2. 风险/报告段（不可逆与外发动作、发布即可能被索引、删除/覆盖前先查看目标、如实报告）
3. `# Session-specific guidance`（按已注册工具动态生成）
4. `# Memory`（仅当有记忆摘要时）
5. `# Environment`
6. `# Output Style`（可选）
7. `# Context management` + 自主性附录
8. `gitStatus:` 快照（可选）

契约还规定**环境段不得包含 git 分支/状态/commit 细节**（那些归 `gitStatus:` 快照），以及**稳定段文案只用英文**，理由是"prompt behavior is consistent across locales"。

## 二、模型优化机制

### 2.1 声明式模型目录

模型能力全部声明在 `config/provider/zcode-builtin.json` 的 `modelConfigRules.modelRules`：数组按顺序匹配，每项 = `modelMatch`（正则）+ `apiTypeMatch` + `baseUrlMatch` + `config`。

```jsonc
{
  "modelMatch": ".*glm-5\\.3(?:-flash)?(?:[.\\-:/\\[].*)?",
  "config": {
    "properties": { "contextWindow": 1000000, "inputFormat": {...} },
    "optionSpecs": {
      "reasoningLevel": { "values": ["low", "high", "max"] },
      "maxOutputTokens": { "max": 128000 }
    }
  }
}
```

**`properties` 是能力面**：`contextWindow` / `inputFormat`（text·image·video·audio·pdf）/ `supportsToolCall` / `supportsJsonSchemaOutput` / `supportsNativeWebSearch` / `supportsMidConversationSystem` / `requiresMfjsToolSchema`。

### 2.2 `reasoningLevel.map` 是受限 CEL 表达式

`packages/model-option-map`（tokenizer / parser / compiler / evaluator / merge-patch，867 行）实现了一个 **Restricted CEL** 求值器：支持三元、比较、`&&`/`||`、对象/数组字面量，编译成 **JSON Merge Patch** 打到请求体上。

同一档位值在**不同传输层映射成不同请求体**：

| 传输 | GLM-5.3 的映射 |
| --- | --- |
| `anthropic-messages` | `{"thinking":{"type":"enabled"},"output_config":{"effort": level}}` |
| `openai-chat-completions` | `{"reasoning_effort": level}` |

`maxOutputTokens` 同理：`{"max_tokens": maxOutputTokens}` / `{"max_completion_tokens": ...}` / `{"max_output_tokens": ...}` 按传输分。

### 2.3 演进史：从"按名字推断"到"声明式配置"

`docs/design/v2/model/glm-5.2-reasoning-depth.md` 头部标着**已被 Provider Refactor 取代（2026-08-24）**，并明写：

> 本文描述的 modelId prefix matcher、`default-policy`、`providerOptionsByLevel` 和 Runtime 反向匹配均已删除……**禁止恢复本文的按名称推断实现。**

旧方案是代码里硬编码 `isGlm52ModelId` 前缀匹配 + 两张工厂（OpenAI 兼容 / Anthropic 各一张）；新方案是上面那套 JSON 规则。**方向是从"代码里按名字推断"改成"配置里显式声明"**。

### 2.4 传输层必须分开映射（一个真实 bug 的教训）

GLM-5.2 文档记录：**把 `openaiCompatible` 的 option set 复用到 Anthropic 兼容模型上，会产生"请求里没有 thinking 字段、而 UI 显示思考已开"的 bug**。原因是 `providerOptionsByLevel` 按 AI SDK provider kind 命名空间隔离，provider 只读自己那一片。先例是 DeepSeek-V4 的双工厂。这条对任何做多传输适配的 harness 都成立。

## 三、GLM 专属事实（本次实测自配置）

| 模型 | contextWindow | reasoningLevel 档位 | maxOutputTokens |
| --- | --- | --- | --- |
| glm-5 | 200k | `disabled` / `enabled` | 64k |
| glm-5.1 | 200k | `disabled` / `enabled` | 64k |
| glm-5.2 | **1M** | `disabled` / `high` / `max` | 128k |
| **glm-5.3 / 5.3-flash** | **1M** | **`low` / `high` / `max`（无 disabled）** | **128k**（opencode-go zen 端点 131,072） |

- **`glm-5.3` 与 `glm-5.3-flash` 的差别只在多模态**：`5.3-flash` 追加 `supportsImage/Video/Pdf: true`，`glm-5.3` 纯文本。其余（1M 上下文、三档、maxOutput）相同。
- **GLM-5.3 的档位里没有"关思考"**：`values` 无 `disabled`，且 Anthropic 映射把 `"type": "enabled"` **硬编码**——只能调 effort，不能关。
- **`supportsMidConversationSystem` 默认 `false`**，只有 `claude-opus-4.8/5` 等 fast-supported 模型为 `true`。GLM 走的是"非 anthropic kind 强制关 + anthropic kind 需 baseURL 命中 allowlist"的路径（见 `docs/plan/trajectory/mcs-dynamic-capability-projection-plan.md`）。MCS 关闭时，system-reminder 回退投影成 **legacy `role: "user"` + `<system-reminder>` 包装**。

## 四、与 RedCode 的分层对照

| 维度 | ZCode | RedCode |
| --- | --- | --- |
| 提示词份数 | **1 份，模型无关** | **16 支**（6 叠加 + 10 独立） |
| 工具描述位置 | provider `tools` 字段，**契约禁止进提示词** | `default.md` 有 `# Tools` 段 + 25 个 `tool/*.md` |
| 模型适配载体 | **声明式 JSON**（`modelMatch` 正则 + CEL map） | **TS 代码**（`transform.ts` 版本解析 + 硬编码表） |
| 系统消息分段 | **3 条**（prefix / static / dynamic），各有缓存断点 | 单段 system + 工具表单独缓存（`_caches.system` / `_caches.tools`） |
| 提示词语言 | 稳定段强制英文 | 中英混排（soul + 中文注释） |
| 档位别名处理 | `values` 白名单（只列真实档位） | 白名单 + 注释说明"全摆出来是骗人的" |

**RedCode 在参数适配上的成熟度不低**：`transform.ts` 按版本门控 `reasoning_effort`，GLM-5.2 用 `GLM_EFFORTS` 去重别名，GLM-5.3 单独使用官方档位 `GLM_5_3_EFFORTS`；通用模型仍由 models.dev 数据兜底，实测特判优先。**差别在载体，不在水平。**

## 五、GLM-5.3 档位分歧（已解决）

RedCode 旧映射与 GLM-5.3 官方档位不一致；ZCode 自配置观察与官方文档一致：

| 来源 | 档位集合 |
| --- | --- |
| **RedCode 旧映射**（`transform.ts`） | `none` / `high` / `max` |
| **ZCode 自配置观察**（`zcode-builtin.json:1025`） | `low` / `high` / `max` |
| **GLM-5.3 / 5.3-Flash 官方** | `low` / `high` / `max` |

### 决策（261015）

智谱[核心参数文档](https://docs.bigmodel.cn/cn/guide/start/concept-param)明确列出 GLM-5.3 与 GLM-5.3-Flash 的档位为 `low` / `high` / `max`；`medium` 只在 GLM-5.2 的别名规则中映射到 `high`，5.3 不支持 `none`。RedCode 按 5.3 精确版本发送这三档，GLM-5.2 保留 `none` / `high` / `max`。

映射单测覆盖两代档位及 `max` 的请求值；本次未对上游发送真实请求。

## 六、可参考项（候选，非优劣判断）

> 本节只登记「ZCode 这么做、我们没这么做」的事实与各自前提，**不构成"他们更好"的判断**。是否采纳，要按 RedCode 自己的判据逐条过。

1. **工具边界纪律** —— ZCode 把"工具使用哲学"与"工具 schema"分开，并用契约 + 测试断言固化（禁止在提示词里重印 schema 或维护工具清单）。与 RedCode 刚做的工具描述分层同向，差别在固化手段：ZCode 靠契约与断言，RedCode 目前靠约定。**前提不同**：ZCode 提示词单份，RedCode 有 16 支分支 + 25 个工具描述文件，搬这套约束要先算清覆盖成本。
2. **静态/动态系统段分离** —— ZCode 把"每会话可能变"的段与"整场不变"的段拆成两条 system 消息、各带缓存标记；RedCode 目前单段 system。**待算**：RedCode 的 `_caches.system` 已按 session+model 缓存，拆段的实际收益取决于动态段的变化频率，不能先假定更优。
3. **模型适配声明式化** —— `modelMatch` + `optionSpecs.map` 让加新模型不改代码；RedCode 每加一个模型的档位要改 `transform.ts`（可能还要改 `system.ts`）。**前提不同**：RedCode 的档位表是实测校准出来的（别名去重、版本门控），声明式化要先解决"实测特判怎么进配置"。
4. **传输层映射分开**（§2.4）—— 这是 bug 教训而非风格偏好：复用一套 option set 到另一传输，会产生"请求里没有 thinking 字段、UI 却显示已开"。RedCode 现有实现是否已分传输，需核对。
5. **按 provider 缓存断点上限倒推分段数** —— RedCode 尚未把断点预算当约束。**待核实**：主力 provider 的断点上限是多少、当前用掉几个。

### 6.1 一条明确不采纳

**安全边界 `SECURITY_NOTICE`（见 §10.3）——不采纳。** 判定理由（2026-10-13 定）：真正不能做的请求，模型在请求当下自然会拒；不需要为此在系统提示里长期占一段固定前缀。

**识别签名**：以后再看到"ZCode 有安全段、我们没有"，按本条处理，不重复提议。

### 6.2 一条建议（参考）

**把散落的运行时事实收进一个统一的 `# Harness` 块。** 仅作**参考建议**登记，不作优劣结论。

事实层面：ZCode 把「终端 markdown 渲染 / 权限拒绝即用户否决（调整而非原样重试）/ mid-conversation system turn 是系统控制而非函数结果、hook 输出当用户反馈 / 优先专用工具 / 并行 / `file_path:line_number`」收在**一个**块里，并放在 static 段。RedCode 这些内容目前散在 `# What the user actually sees`、`# Tools` 等处。

**收益面**：同类内容归一处，模型不必跨段拼；若该块能进静态前缀，缓存位置也更稳。

**代价面**：这是**模型可见改动**（按 `AGENTS.md` 要走四问）；把散落的句子搬进新段等于**移动前缀**——从移动点起整段前缀作废；搬运过程容易丢细节，例如"取消即决定"现在挂在 Tools 段，搬走后与工具语义脱钩是否更差，需逐条判断。

**为什么不构成"他们更好"**：ZCode 单份提示词、无模型分支，天然适合集中；RedCode 有 16 支分支与 soul 人格层，同一句话在不同分支的归属未必一致。**是否值得，按 RedCode 自己的判据逐条过，不因对方这么写就搬。**

**下一步（若要做）**：先只做**清点**——列出散落在各段的运行时事实句、各自当前位置、以及"搬到统一块后是否丢失上下文"的逐条判断，再决定动不动。清点本身不改任何模型可见字节。

## 七、不适用项

1. **单份提示词**：ZCode 单份是因为只服务 GLM 一家；RedCode 的按模型 delta 有实测依据（step 想太多不产出、deepseek-flash 缺深度），合并会丢掉纠偏能力。
2. **英文-only 稳定段**：RedCode 有中文用户与 soul 人格文件，语言策略不同。
3. **`requiresMfjsToolSchema` 那类单 provider 开关**：属特定 provider 的历史包袱，与本仓无关。

## 八、待核实

1. **GLM-5.3 能否禁用思考**（§五）——决定 RedCode 的 `none` 档对错。
2. GLM-5.3 是否该补 `low` 档。
3. ZCode 的 `optionSpecs` 是否真的覆盖了 5.3 全部端点（`opencode-go zen` 走 `providerSiteRules` 另有一套，maxOutput 131,072 与主规则 128,000 不同）——多端点差异目前靠规则叠加，值得看是否有遗漏组合。

## 九、附：GPT 路由 / 缓存亲和对照

对照对象是 RedCode 近期三批 GPT 路由改动（`0dc25392` 亲和头与粘性路由、`c9113c4f` 请求链隔离与 routing hint、`7ff5acb6` 取证补盲，决策见 `docs/notes/implemented/bug-fix/2026-10-13-codex-routing-affinity.md`）。

### 9.1 RedCode 做的是「服务端缓存亲和」

目标后端是 **ChatGPT OAuth（Codex）**，它的缓存是**服务端隐式亲和**——按会话路由到固定后端实例，靠请求头维持亲和，而不是靠显式断点。三批分别是：亲和头（`session-id` / `thread-id`）+ 同 turn 首响应的 `x-codex-turn-state` 粘性令牌；请求链隔离（`codexTurnKey = SHA-256([sessionID, userID, agent, wireModelID])`，防标题令牌抢占主对话槽位）+ 从最终正文取的 `x-codex-routing-hint: model=…;tier=…`；以及 SDK 归一化前的原始 usage 观测 + 路由头 HMAC 指纹。

### 9.2 ZCode 的对应物

| 能力 | RedCode | ZCode |
| --- | --- | --- |
| 请求归因头 | 部分（`x-redcode-turn` 等内部键） | **有**：`x-zcode-trace-id` / `x-request-id` / `x-session-id` / `x-query-id` / `x-zcode-session-type` / `x-opencode-session` |
| 来源区分（主对话 vs 辅助） | 客户端隔离路由键 | **有**：`x-zcode-session-type: main\|subagent\|side_chat\|other` |
| 粘性路由令牌 | **有**（`x-codex-turn-state`） | 无 |
| routing hint（`model=…;tier=…`） | **有** | 无 |
| `prompt_cache_key` | **有**（与 `session-id` 头同源） | 无 |
| 缓存机制 | 服务端隐式亲和 | 客户端显式断点 `cacheControl: ephemeral` |
| 路由头取证 | **HMAC 指纹**（可判断两次是否同一） | `[redacted]` 定值替换 |

**一处同题异解，值得注意**：`x-zcode-session-type` 与 RedCode 的 `codexTurnKey` 解的是**同一个问题**——主对话与标题/副会话的请求不能混。但方向相反：ZCode 把来源**声明给服务端**，由服务端分流；RedCode 在**客户端隔离路由键**，让标题令牌无法占用主对话的槽位。两者不冲突，可叠加：客户端隔离解决"令牌串用"，服务端声明解决"服务端认不出来源"。RedCode 目前没有等价的来源声明头（`x-redcode-turn` 是内部键，不是给服务端的语义标签）。

**一处取证上的实质差距**：ZCode 的 `sanitizeModelNetworkHeaders`（`runner-network-headers.ts`）把敏感头替换成固定的 `[redacted]` 字符串——**可比性被销毁**：两次请求的 `session-id` 是否变了，从日志里看不出来。RedCode 用**进程内 HMAC 指纹**正是为了保住可比性。这条反向印证了 `7ff5acb6` 的取舍（当时"路由头完全不可观测"就是无法定性的障碍）——定值 redaction 依然不可观测。

### 9.3 为什么 ZCode 结构上不需要

- **不接 ChatGPT OAuth**：认证类型只有 `api-key` / `builtin` / `zhipu-account` / `zhipu-coding-plan-api-key`，**没有 OAuth provider**。GPT 模型（`gpt-5.3-codex` / `gpt-5.6-sol·terra·luna`）走 openrouter / opencode-go 聚合商，无服务端隐式亲和可言。
- **ZCode 的"路由"是另一回事**：`provider-endpoint-routing.md` 是**出网改写到自己网关**（`open.bigmodel.cn/api/anthropic/v1/messages` → `/api/v1/ultra/anthropic/v1/messages`），解决的是计划/配额入口，不是缓存亲和。
- **它的缓存断点只对 anthropic 生效**：`providerOptionsForCacheControl`（`transform.ts:502-516`）只往 `providerOptions.anthropic.cacheControl` 写。非 anthropic 传输拿到断点语义了吗——按这份实现没有。

### 9.4 结论

**ZCode 没有等价于 RedCode 那三批的优化**，且它当前只服务 api-key 类 provider，没有触发该需求的条件。唯一的重合点是**来源区分**（`x-zcode-session-type` ↔ `codexTurnKey`），且两者互补而非重复——RedCode 若要从这里拿一条，拿的是"给服务端一个可读的来源声明"，不是路由令牌机制。

## 十、GLM 面向的提示词内容对照（不含工具描述）

### 10.0 先纠正一个前提：ZCode 没有「给 GLM 的提示词」

ZCode 全仓提示词文本里**一处 GLM 都没有**。仅有的命中是三处非提示词内容：一条代码注释（零工具的 GLM 子代理）、一条 compact 注释（GLM/Z.AI 可能以 length + 空文本完成）、以及 bundled skill 里把 `GLM-5.3-Flash` 当模型名举例。**且全仓没有任何按模型族选提示词的逻辑。**

所以真实对比是：**RedCode 的 GLM 面向提示词**（`default.md` + `glm.md` 2 条 delta）**vs ZCode 的通用提示词**（GLM 拿到的那一份，与所有模型一字不差）。

### 10.1 预算分配（字符数，已排除工具描述）

| RedCode `default.md`（去掉 `# Tools` 后 7,991） | 占比 | ZCode 核心（8,561） | 占比 |
| --- | --- | --- | --- |
| `# What the user actually sees` 2,294 | 29% | 沟通段 + 风险段 3,698 | **43%** |
| `# Intent and scope` 1,254 | 16% | 上下文管理 + 自主性附录 2,936 | 34% |
| `# Working in someone else's codebase` 1,175 | 15% | `# Harness` 1,336 | 16% |
| `# RedCode` 861 | 11% | 安全边界 459 | 5% |
| `# Autonomy and completion` 511 | 6% | CLI prefix + 引言 132 | 2% |
| `# Steering and continuity` 497 | 6% | | |
| `# Context efficiency` 435 | 5% | | |
| `# Images` 408 | 5% | | |
| `# Environment` 341 | 4% | | |
| 引言 215 | 3% | | |

**总量接近（约 8.0k vs 8.6k 字符），分配完全不同**：ZCode 把 77% 压在「沟通」与「上下文/自主性」两块上；RedCode 摊得更平，且**没有安全边界块**。

### 10.2 RedCode 有、ZCode 没有

- **`# Intent and scope`（1,254）**——其中最关键一条：**"coding session 里一个具体 bug 描述隐含 scoped fix，即使以问句形式提出"**。ZCode 只有一句「用户在描述问题/提问/自言自语时，交付物是评估，报告并停」，**没有这条默认行动推断**。
- **`# Context efficiency`（435）**——一次 scoped 读胜过多次小读、大文件先定位、复用既有事实。ZCode 的 `# Context management` 讲的是**另一件事**（压缩会发生 → 从摘要继续 → 别提前收尾），不是省 context 的策略。
- **`# Images`（408）**——截图优先于我的模型判断、下采样要换算回原坐标。ZCode 有多模态**能力声明**，但提示词层没有图片纪律。
- **`# Environment` 的 GBK 警告（341 的主体）**——"bash/PowerShell 默认系统码页，非 ASCII 经 shell 会被搞乱，且运行时不可推断"。这是实测踩坑得来的约束；ZCode 的环境段是纯事实清单（cwd / platform / shell / osVersion / model / git repo 布尔），**没有这一条**。
- **`# Steering and continuity`（497）**——中途消息视为增补、状态问题先答再继续、压缩不是任务边界。
- **`# RedCode`（861）**——URL 不猜、help/feedback 去向、RedCode 自身问答、`<system-reminder>` 权威性、不主动 commit，以及**"语气/称呼/详略由 soul 决定，本文件不规定——两处都立法会让调 soul 时被莫名拽回"**。

### 10.3 ZCode 有、RedCode 没有

- **安全边界 `SECURITY_NOTICE`（459）**——正面授权防御性安全 / 漏洞分析 / CTF / 教育；明确列出拒绝类别（破坏性技术、DoS、大规模攻击、供应链投毒、规避检测）；双用途工具需明确授权语境。RedCode 没有等价段。**已判定不采纳，理由见 §6.1。**
- **`# Harness`（1,336）**——把「运行时事实」单独成块：终端 markdown 渲染、**权限拒绝即用户否决（调整而非原样重试）**、**mid-conversation system turn 是系统控制而非函数结果 / hook 输出当用户反馈**、优先专用工具、并行、`file_path:line_number`。RedCode 的对应内容散落在 `# What the user actually sees` 与 `# Tools`（如"取消即决定"）。**仅登记为参考候选，见 §6.2——不作优劣结论。**
- **`# Communicating with the user`（约 2,750，占全预算 1/3）**——见下。

### 10.4 同一主题、取向不同

**输出观**：两边都讲"不复述推理、先给结果、形状匹配问题"。但命题不同——

- ZCode 的核心是 **"readable 比 concise 重要；短靠选材，不靠压缩"**，并把**箭头链 `A → B → fails`、缩写、碎片化**明确列为反例，要求"完整句子、术语写全、不要发明标签让读者回头对照"。
- RedCode 的核心是 **"长度跟着需求走，不设固定上限"** + **"结束前检查最后一段，是计划/IOU 就没做完"** + **"无元评论"**。

即：ZCode 立的是**可读性下限**，RedCode 立的是**不注水 + 不留尾巴**。

**自主性**：ZCode 把它挂在 `# Context management` 之后作附录（4 段），核心是"用户没在实时看，别问 Shall I"+"回合末检查最后一段"。RedCode 独立成 `# Autonomy and completion`，且更锐利——**明确列出不是停止条件的东西**（难度、token 消耗、首次失败、状态问询）。**这一段 RedCode 明显更强。**

### 10.5 `glm.md` 那两条在 ZCode 的对应情况

- **「推理必须收敛」→ ZCode 有近亲，但归属不同。** ZCode 的 `# Context management` additional 里有"够了就动，不要重推已确认的事实、不要重开用户已做的决定、不要罗列你不会选的选项"。内容接近，但 **ZCode 把它放在「上下文管理」语义下（面向所有模型，讲的是别浪费轮次）；RedCode 放在 GLM delta 里（面向 GLM，讲的是推理要收敛）**。同一句话，一个当通用效率规则，一个当模型纠偏。
- **「暴露的 reasoning 用简体中文」→ ZCode 无对应。** ZCode 稳定段强制英文，也没有 reasoning 语言策略。

### 10.6 小结

去掉工具描述后，两边的**差异不在体量，在立法边界**：

1. ZCode 把预算压在**沟通可读性**（43%）和**上下文/自主性**（34%）上，且**不区分模型**；RedCode 摊平，并为 GLM 单独加了 2 条纠偏。
2. RedCode 的**范围推断**（bug 描述隐含 scoped fix）、**上下文效率**、**GBK 环境警告**、**人格层边界（soul）**是 ZCode 完全没有的。
3. ZCode 有而我们没有的三块：**安全边界**（已判不采纳，§6.1）、**Harness 块**（仅作参考候选，§6.2）、**沟通可读性下限**（尚未评估）。
4. 唯一实质重合的是「推理收敛」——但两边把它归到了不同的语义层。

## 来源

- `apps/zcode-cli/docs/design/v2/loop/system-prompt-contract.md`（257 行，权威契约）
- `apps/zcode-cli/packages/core/src/context/builder.ts`、`dynamic-sections.ts`、`sections/*.ts`
- `apps/zcode-cli/docs/design/v2/model/glm-5.2-reasoning-depth.md`（已标退役，含演进史与传输层教训）
- `config/provider/zcode-builtin.json`（6,391 行，模型目录）
- `packages/model-option-map/`（CEL 求值器）
- `apps/zcode-cli/docs/plan/trajectory/mcs-dynamic-capability-projection-plan.md`
- RedCode 对照：`packages/opencode/src/session/system.ts`、`provider/transform.ts`
