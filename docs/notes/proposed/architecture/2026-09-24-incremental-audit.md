# 增量审计（二）：上一份 18 条的落地记分牌，以及新代码里的 1/35 与四道预算旁路

日期：2026-09-24 · 状态：proposed · 窗口：`fb934d71..034a8649`（0.11.9 → 0.11.13，83 commit / 164 文件 / +8086 −2006）· 前一份：`2026-09-18-full-repo-audit.md`

> 本文只收**读码确认**的条目，每条带 `file:line` 与**同形状兄弟数**。`inferred` 的单列在文末。四路子审计（胶囊 UI / 工具输出预算与 spill / provider 与提示词 / 实时同步韧性）结论均由主 agent 二次复核，复核口径见文末。
>
> **回链义务**：本轮修复落地时，commit 回链本文对应小节编号（`§N`）。
>
> **独立复核状态**：正文保留第三方原文；部分判词与排序已复核修正。先看文末「Karina 独立核验」，再把 §五当候选队列使用。

---

## 一、上一份审计的落地记分牌

上一份的批注（`2026-09-18-full-repo-audit.md:426-449`，Karina 260918）我全部接受——其中两条判词我这次独立复核，**确认是我错**：

| 我原来的判词 | 复核结果 |
| --- | --- |
| §2.2「`tools.ts:362 content: result.content` 把含 base64 的响应整体落库」 | ❌ **我错**。`processor.ts:381` 的 `toolResultOutput` 只取 `{title, metadata, output, attachments}`，`content` 是死字段。真实缺口只有"非 image mime 不过缩放器"+"条数无上限"两条 |
| §5.2「v1/v2 双 projector 写同一批表，五处一起改」 | ❌ **我错**。`projectors.ts:9` 写 `MessageTable`/`PartTable`，`projectors-next.ts:9` 写 `SessionMessageTable`，仅 `SessionTable` 有交集。我另查了唯一危险的形态——两边对 `SessionTable` 同一列做 `+=` 增量——**不存在**（v2 在 `:124/:134` 只 `set` 标量列 `agent`/`model`），按他们说的改会出事故这条成立 |
| §3.1 Timeline「24% 帧预算」 | ❌ 数字站不住。我从 3.96ms/16ms 推 24%，而源码注释自陈"长会话 11%"，两者矛盾且无 benchmark。**2N 次 `key()` 是事实，等级不是** |
| §4.6 msgPin 无字节回收 | ❌ 已过时，`prompt-caches.ts` + `session-evictor.ts` 已有 TTL/上限 |
| §2.4 引用 `prompt.ts:224` | ❌ 位置错，实际在 `session/llm.ts:184-229`（catch 在 224-225）。关切成立，指针错 |

**记分牌**（18 条建议 → 现状，逐项 grep/读码实测）：

| 类别 | 已落地 | 部分 | 未动 |
| --- | --- | --- | --- |
| 引擎健壮性 §2 | 2 条（§2.1 机制、§2.3 slash） | 1（§2.2 闸门加了但无测试接缝） | canary 静默、MCP 重试分类 |
| 性能数据层 §4 | — | 1（§4.4 撤下前实际已改主键点查） | **§4.1 event 零索引、§4.2 metadata 无帽+patch 双写、§4.5 排序索引、§4.6 无 VACUUM** |
| UI §3 | — | — | **§3.1 reuse、§3.2 TUI 节流（grep `throttle\|debounce` = 0）** |
| 架构 §5 | — | — | 分歧反而加速（见 §二） |
| 工程卫生 §6 | — | — | **全部 6 条**：`bun.lock` 仍被 `.gitignore:31` 排除、workflows 仍 3 个、`packages/redcode` 死引用仍 6 处、`llm` 仍无 `test:ci`、`network.ts:79-83` 仍静默注入公开密码、`.oxlintrc.json` 仍全 `warn` |

**这条趋势本身就是发现**：挡住功能交付的审计条目被认真处理并回链代码（`prompt.ts:1986` 写着"见审计 §2.3"、`compaction.ts:702` 回链 §4.4、`2026-08-21` note 补记了门检盲区）；需要基础设施时间、且当下不咬人的条目（§6 六条）**一条未动**。上一份把它们排在第一梯队是判断失误——它们不在任何人的阻塞路径上。本轮排序（§五）改成"要么现在正咬人，要么加一道自动闸门让它自己咬人"。

**分歧趋势（可量化）**：`// YYMMDD Red` 标记 6 天内 **559 → 598 处**、137 → **143 文件**，`session/prompt.ts` 单文件 65 → **69**；`os.homedir()` 绕过 `REDCODE_TEST_HOME` 的点 **19 → 27 处**。两条曲线都在涨。

---

## 二、本轮头条：已知正确解存在 5 周，落地 1/35

`packages/core/src/util/binary.ts:20-22` 有一个 `Binary.searchBy`，它的注释写明**为什么存在**：

> 260814 Red 自定义比较器二分：ID 48 位编码回绕后字典序不再单调（795 天周期），按 `time.created` 排序的数组必须用 comparator 定位。

同批记录实测：`2026-08-14 19:19:55` 已发生**第 26 次回绕**，"ID 字典序比较全部失真"。

实测分布：**`searchBy` 全仓 1 个调用点**（`opencode/src/cli/cmd/tui/context/sync.tsx:351`），**遗留 `Binary.search` 34 处**。

最尖锐的一处在 `packages/app/src/context/global-sync/event-reducer.ts:176 / :196 / :229 / :294`：它对 `store.session` 做 `Binary.search(..., s => s.id)`（隐含假设 id 字典序**升序**），但——

1. 该数组在 `server-sync.tsx:376` 按 `compareTime` **时间升序**排序，那行注释自己写着"ID 回绕后字典序失真"；
2. session id 是**降序编码**（`core/src/session.ts:10` → `Identifier.descending()` → `id.ts` 里 `now = ~now`），时间越大字典序越小。

⇒ **数组实际顺序与比较器假设整体相反**，不是回绕才错，是每次都错。`app/src/pages/session/message-timeline.tsx` 侧的 `message.updated` 分支（`event-reducer.ts:273-284`，260831）已经把二分改成线性 `findIndex` + `compareTime` 插入位，注释还专门解释了为什么；**同一个规则没有应用到紧邻的 session 数组和 parts/permissions/questions**（`:366/:389/:395/:408/:439/:457/:475/:494`）。

**这不是 8 个 bug，是 1 个规则没落地第二次。** 上一份的 §1 讲"修了兄弟漏了兄弟"，本轮给它一个可引用的数字：**1/35**。

---

## 三、新增缺陷（新代码里的，按严重度）

### 3.1 🔴 新上的工具输出预算恰好跳过了产量最大的工具

`packages/opencode/src/tool/tool.ts:155`：

```ts
if (result.metadata.truncated !== undefined) return result   // 直接返回，不进 truncate.result / fitToolResult
```

"这个工具自己截过"被当成"这条不需要模型侧预算"。而 `ast_grep / git / glob / grep / read / repo_overview / shell / registry / task-runtime` **九个工作区里最重的工具每次返回都带 `truncated` 键**（`grep -rln truncated src/tool/*.ts`）⇒ 0.11.13 的"工具结果模型侧多模态 token 预算与可恢复 spill"对它们整条旁路，既不 fit 也不 spill。

**同形状兄弟数**：短路点 1（`tool.ts:155`），受影响的工具 ≥6。
**最小修法**：判据改成"`metadata.outputPath !== undefined`（真 spill 过）才跳过"，而不是"标过 truncated"。

### 3.2 🔴 非图片附件在预算里计 0 价，且其"已被限住"的前提只对 MCP 成立

`packages/opencode/src/session/image-tokens.ts:112-114` `attachmentRequestTokens()` 对非 `image/*` 返回 **0**，注释给的理由是"它已经被字节线（5MB base64）与条数线（32）限住"，按 base64/4 计会把每个合法 PDF 判出局。

前提本身可查，实测**只对 MCP 一条路成立**：`MAX_ATTACHMENTS = 32` 全仓只出现在 `session/tools.ts:43`（MCP 专用），`read.ts` 的 PDF 路径与所有插件工具**都没有条数线**。而 `fitToolResult` 的 `break` 对 0 价永不触发（`image-tokens.ts:165-169`）⇒ **两道门（写入侧 `truncate.result` 与回放侧 `message-v2.ts:903`）共用这同一个函数，同时开洞**。MCP 侧的 32×5MB=160MB base64 记作 0 token。

**同形状兄弟数**：2 道门共用 1 个函数；缺条数线的生产者 ≥2（read.ts、插件工具）。
**最小修法**：非图片返回 `max(ATTACHMENT_ENVELOPE, ceil(base64Bytes/4 × α))` 下界，并在 `fitToolResult` 里加统一硬条数线——**一个 chokepoint，别指望各生产者自觉**。

### 3.3 🔴 交付了 1M 上下文的模型，但阈值表不随仓库走，且未命中零告警

`seed/redcode.home.jsonc:167-179` 交付 step-5-preview（1M 窗口），而 `find seed -name 'dcp*'` = **0**：仓库不携带 `dcp.jsonc` 模板。`seed/*.jsonc:12` 注释自陈该配置**每台机器各自在本地维护**（"E 盘机写 `E:/AI/RedCode-dcp`，D 盘机写 `D:/AI/KLX/Qiu/RedCode-dcp`"）。

DCP 侧 `lib/messages/inject/utils.ts:134-136` 在表为空时 `continue`——**一张表都没有时连 miss 告警都不发**，全部静默落到 `lib/config.ts:781-782` 的 50k/100k。后果：1M 模型用到 5% 就反复压缩，每次压缩改写历史 → **整段前缀缓存作废**。

这正是本机 live `dcp.jsonc` 注释里逐字记录的 **260811 / 260902 / 260904 三次同因事故**（"未命中不会有任何警告""静默回落全局 50k/100k"）**第四次**，且这次是随版本发布带出去的。

**最小修法**：`seed/` 出 `dcp.jsonc` 模板，或主仓启动时把"已装配模型目录"与 `modelMinLimits` 的键做差集并 warn。**这条同时满足两个条件：新机必踩、且踩了不出声**——按本仓红线「误配置要响」，它应当排在所有性能条目之前。

### 3.4 🔴 胶囊：`SYSTEM_TABS` 只统一了读侧与 close，没统一写侧（状态模型仍是两份事实）

`layout.tsx:100` 声明 5 项固定、`helpers.ts:45` 从视图滤掉、`layout.tsx:131` 拒绝关闭——**但 `layout.tsx:109` 的 `DEFAULT_SESSION_TABS.all = ["context"]` 把 system id 塞进 `all[]`，`:115` 又把 `outline/plan/status` 追加进去**，而 getter `:934` 与 `setAll :946` 只过滤 `"review"` ⇒ **5 项里 4 项泄漏进"文件标签"视图**。

更糟的是 `layout.test.ts:89-101` 断言了 `all == ["context","outline"]`——**测试把这个错误不变量钉住了**。可观测后果：① `session.tsx:153-165` 的 workspace→session handoff 会把 system id 复制进别的会话的 `all[]`；② 拖拽排序在 `tabs().all()`（含 system id）与 `openedTabs()`（不含）**两个索引空间之间换算**（`session-side-panel.tsx:218-221` → `layout.tsx:968`）；③ `all[]` 单调增长且持久化（`:223-262` 的 migration 不清 system id）。

**同形状兄弟数**：过滤点 4（`:934/:946/:113/helpers.ts:45`），**只有 1 个用 `SYSTEM_TABS`**。
**最小修法**：`nextSessionTabsForOpen` 对 `SYSTEM_TABS.has(tab)` 只改 `active`、绝不写 `all`；`DEFAULT_SESSION_TABS.all = []`；migration 一次性剔除；**同步改 `layout.test.ts` 的断言**。

### 3.5 🔴 Virtualizer cache 跨会话别名——identity 修复只做了一半

`b3188e6f` 把 sessionKey 纳入 Virtualizer identity，但 `message-timeline.tsx:730 / :740 / :749` 三处 `writeTimelineCache(key, keys, width, virtualizer)` 的 **handle 取自组件级 `let virtualizer`，key 取自另一条时间线**（`cacheSessionKey`/`next[0]`/`virtualizerSessionKey`）。切 A→B 时无论 `createEffect`（:726）与 `:2038` keyed `Show` 谁先销毁，必然出现「新 key + 旧 handle」或「旧 key + 新 handle」的配对写入 ⇒ `timelineCache` 里某会话的条目指向**另一个会话正在写的 cache 对象**。`cacheReusable`（`message-timeline.data.ts:167`）只比 row key 前缀，比对必然通过 → 切回会话时把别人的实测尺寸当自己的用，行高错位，且 `itemSize` 因 cache 非空而丢掉 60px 兜底。

**混合状态没被消灭，只是从实例内挪进了缓存表。**
**同形状兄弟数**：3 处写入 + `onCleanup`，**全部同错**。
**最小修法**：cache 只在 Virtualizer 自己的 `ref` 里写，key 绑在实例上（`:2048` 已有 `v.session`），删掉那三个模块级 `let`。

### 3.6 🟠 `8447daff`（message.removed 线性定位）也是"修了兄弟漏了兄弟"

只改了 `message.updated`/`removed` 两处。`prt/usr/ses/msg` 共用同一时间编码生成器（`opencode/src/id/id.ts:22-62`），`event-reducer.ts` 仍有 **17 处** `Binary.search`：part 定位（`:366/:389/:408` → **流式文本静默丢**）、permission.replied（`:457` → **ghost 弹窗点了没反应**，与已修的 ghost message 同构后果）、question（`:475/:494`）。这条与 §二 是同一个洞的两半。

### 3.7 🟠 「有界消息窗口」与 autoScroll 都只修了症状

- `47a185cd` 把上限 100→400（`message-window.ts:8`）是**推迟不是消除**：挂载会话流式超 400 条（无人值守长任务可达）即恢复逐条 head shift → 行前缀变化 → `readTimelineCache`（`message-timeline.tsx:114-118`）**仍在 createMemo 体内 delete**（`:536` 调用）→ `virtualCache()` undefined → `itemSize=60`（`:2056`）→ 整列塌缩重测，「闪一下」原样存活。**新触发器**：cache 有效域含 width，但回写 effect 只依赖 `[sessionKey, timelineRowKeys]`（`:727-745`）⇒ resize 只删不写。窗口数字 400/100/200/40 / `contain-intrinsic-size auto 200px` / fallback 60 **无任何共享常量关联**。
- `8c5ed203` 的 autoScroll 重置也没碰根：`session.tsx:125-128` 的 `working: () => true` **原样在**，`create-auto-scroll.tsx:26` 的 `active()` 恒真、`on(options.working)` 回调永不再触发 ⇒ "结束→settle 300ms"整条分支是死代码。

### 3.8 🟠 模型可见改动的四问纪律：8 个 commit 里 2 个答满

实测各路由 system 首段总字符（`default.md` 6729 **全程字节未变** ⇒ 公共基线没膨胀，本轮唯一好消息）：

| 路由 | 窗口前 | HEAD | Δ |
| --- | --- | --- | --- |
| gpt | 13411 | 9691 | −3720 |
| deepseek | 10069 | 7341 | −2728 |
| glm | 7499 | 7117 | −382 |
| **step** | 3645 | **9162** | **+5517 ≈ +1380 tok** |
| mimo | 5812 | 7721 | +1909 |

| commit | 四问 | 备注 |
| --- | --- | --- |
| `250e8405` share common prompt base | **0/4** | 全英文散文，无 token 数、无 KV-cache 字样，却把 gpt.md 13411→227 并改写前缀首段；其决策记录 `2026-09-21-prompt-common-base.md` 也无 ②③④ |
| `82e419f2` step Delta | **0/4** | 本轮**最大单路由增幅 +5517 字符**，commit 只列三条保留的偏差 |
| `65e0ca9a`/`68e950ba` | 1/4 | 只答 Q2，且 `65e0ca9a` 自报的"150→215"被下一 commit 判为低估（"账要实"）。同一重构砍掉的 gpt 专属 ~6455 字符里 2733（≈42%）**三天内被这两刀补回**——而决策记录明写「直接把三份文件各自砍成 Delta：否决」 |
| `f6adc860` MiMo | 3/4 | 原文答了 Q1/Q3/Q4（"its KV cache must warm again. No unbounded injection is added"），缺 Q2 数值 |
| `3e0892fa` step 11 条 | **4/4** | 唯一逐条答满且带实测数字（"固定前缀约 +355 token…低于单项 1K 点名线"）。**可当模板** |
| `035a5147` GPT-6 | 4/4 但 Q2 不完整 | "固定前缀不因本提交增减"对 **tools 半边不成立**：freeform 把 apply_patch 换成 560 字符 Lark 文法 + 79 字符 note，约 **+160 tok/gpt 会话**，而 `prefix-shape.ts` 本就单独统计 `toolSchemaTokens`。CHANGELOG 的"+680 tokens"只报了 227→2960 这一腿，未报 gpt 净 −3720、step 净 +5517 |

**前缀/KV-cache 净结论**：这一轮不是追加而是**换掉首段**——0.11.11 作废 gpt/deepseek/glm/step 四路由全部历史缓存，0.11.12 再作废 mimo（唯一公开承认的一次），0.11.13 因 gpt.md 两次改动 + step.md 重写，对 gpt 与 step **再作废两次**。**三个连续版本各重暖一轮**。未迁移路由（gemini/claude/kimi/minimax/hy/grok/sensenova/ollama）因 `default.md` 未变而零成本——"暂不迁移"这个决策是对的。

**隐式逗号（专项，结论是干净的）**：`SystemPrompt.provider()` 全仓仅一个消费者 `llm/request.ts:60`，已显式 `.join("\n\n")`；`agent.prompt` 是 `Schema.optional(Schema.String)`（`agent.ts:92`）不可能吐数组；`prompt.ts:1542` 全用展开。残留：`system.ts` 仍返回 `string[]` 且有 16 个分支，该不变量只由**一个调用点**守着且**无测试**——建议 `provider()` 直接返回 `string`。

### 3.9 其余新增（带兄弟数）

| 严重度 | 位置 | 缺陷 | 兄弟数 |
| --- | --- | --- | --- |
| 🟠 | `mcp/index.ts:796`→`:803`→`:79` | cap 后把**已截断文本**写盘，读盘再 cap 一次 ⇒ 断线期读到尾部带 `[...truncated 21 chars]` 的字节不同版本 → `mcpGuide` 及其后整段前缀作废，**恰好违反 `:796` 上方注释自陈的目标**。>1970 字符触发 | 2（读/写各 cap 一次） |
| 🟠 | `tool/truncate.ts:98-103` | spill 落盘用**非原子** `writeFileString`，而同服务已提供 `writeFileStringAtomic`（`core/filesystem.ts:180`）⇒ 崩溃留半截文件，而 notice 写着"Full output saved to"。另：只有 7 天龄回收（`:81-96`），无总量/条数上限，**会话删除不清理** | 1 处写盘 |
| 🟠 | `truncate.ts:81-96` | `Identifier.timestamp` 对非 ID 名返回 `NaN`，`NaN >= cutoff` 为 false ⇒ **任何 `tool_*` 异形条目被立即 `remove({recursive:true})`**。判龄失败应偏向保留 | — |
| 🟠 | 明文落盘面扩大 | 被丢附件（截图/PDF 原文）连同全文进 `%LOCALAPPDATA%` 的 `data/tool-output`，7 天、无加密无脱敏；`cli/cmd/export.ts:113` 导出时会 redact，**spill 侧没有同等处理** | 2（export redact / spill 不 redact） |
| 🟡 | `session/image-tokens.ts:26-33` | token 定价表**只有 `deepseek`**（默认值同 384），而 `message-v2.ts:718-729` 证明 anthropic/openai/bedrock/xai/gemini 都是活路径。2M 像素图（`image/image.ts:22`）在 Anthropic ≈ pixels/750 ≈ 2.7k token，收 416 | 5 provider |
| 🟡 | `transform.ts:960` | `GPT6_FAMILY_RE` 只加在 `:960`（与 `:1601`），`azureVariants:1175`、`gpt5CodexReasoningEfforts:968`、`gpt5ChatReasoningEfforts:976`、`copilotVariants:1134` **四处分发器仍只认 `GPT5_FAMILY_RE`**。已核：`GPT6_FAMILY_RE = /(?:^\|\/)gpt-6(?:[.-]\|$)/` 会匹配 `gpt-6-chat`，而 `freeform.ts:79` 与 `options():1603` 都已为 gpt-6 写了 `-chat` 排除 ⇒ 作者预期该形态存在，它将来会拿到 6 档 effort 而 gpt-5-chat 正确只给 `["medium"]` | 5 个分发器，1 个更新 |
| 🟡 | `native-runtime.ts:71-74` | 未上报的行为变化：见到 `type:"provider"` 工具即 return unsupported ⇒ gpt-6 从 `@redcode-ai/llm` native 传输**整体切回 ai-sdk**，commit 只说"工具形态变了" | — |
| 🟡 | `session-side-panel.css:320` | "overlap-free" 用硬编码 `padding-inline-end: 348px`（注释自陈 = 320+12+16），而展开态宽度是 `:50 min(--panel-width, 560px)`、默认 `DEFAULT_SESSION_WIDTH=600` ⇒ 恒定 **224px 覆盖消息/输入区右缘**，与视口无关；且宽桌面下 ResizeHandle 被 `session-side-panel.tsx:497` 禁掉，用户无从修正。另 `session.tsx:186 centered()` 丢了 `&& !desktopFileTreeOpen()` ⇒ 宽桌面开文件树时中心线平移 `fileTree.width/2`，与 `9d360c21` 的目标相反 | 2 |
| 🟡 | `titlebar.tsx:268-272` vs `session-side-panel.tsx:99-107` | 同一 (active, opened) 事实两条写入路径且**语义相反**：点标题栏绿灯强制 `open()`，点胶囊 Status 在宽桌面**故意不 open** —— 这就是 `d90bc943` 的下一次报告。会话 key 字符串拼接另有 3 处同形状（`titlebar.tsx:269`、`session-layout.ts:7`、`helpers.ts:25`，后者全仓零调用是死码） | 3 |
| 🟡 | `session-context-summary.ts:251`、`session-context-tab.tsx:505` | 硬编码中文"缓存未延伸"，英/日界面直出中文。**`parity.test.ts` 测不出非 key 字面量**——五个标签本身三语齐备，parity 绿灯掩盖了这两处 | 2 |
| 🟡 | `sse reconnect` | 补拉失败无痕：锚点消息在断线期被 revert/删除时 `reconnect.ts:47-49` 抛 "exceeded 50 pages/repeated cursor"，`session.tsx:645` 只 `console.error` ⇒ **用户永久少一截消息且零提示**。另 GUI/TUI 重连阈值不一致（60s / 90s），`createReconnectRefresh` 无频率上限；sidecar 阻塞 >阈值即误判断线，重连带来 bootstrap.refetch + 最多 50 页补拉，**给过载服务端再加压** | 2（GUI/TUI 阈值） |
| 🟡 | `directory-sync.ts:545` | SSE 闭环只做一半：补拉只覆盖**当前挂载会话**，其余会话断线期漏的事件因 `cached && !force` 短路永不回填 ⇒ **洞仍在，换个会话才看见**。TUI 侧是整体 REPLACE(limit 100)，与 GUI 语义分裂；diff/goal `.catch(() => undefined)` 静默 | 2（GUI/TUI） |
| 🟡 | `bootstrap.ts:131-137`、`:322` | fail-soft 吞成空视图：GUI `showErrors` **整段注释掉**、agents `.catch(() => done([]))` ⇒ 失败→空列表 + `ready=true`；TUI phase2 失败仅 warn，`mcp {}`/`command []` 呈现为"未配置"而非"加载失败"。**违反「误配置要响」** | 2 |
| 🟡 | `job.ts:80-99` | running 后台任务无界（prune 只裁完成态，50/30min 有界✓），running job 永不回收而 output 可数 MB/条；worktree `scheduleRemove` 是进程内 7 天 sleep fiber，**重启即丢**，靠下次 create 才 reap | — |
| 🟡 | `docs/notes/implemented/bug-fix/2026-09-11-skill-description-budget.md:11` | **旧决策记录与新实现脱节**：该表仍写"工具输出（全部工具，统一包装）2000 行/50KB 可经 `tool_output.*` 配置"——这句现在三条全错（`output()` 在 src 已无调用方、6 个工具压根不经过、配置对通用工具失效）。`config.ts:327-333` 的 description 还在承诺"truncated and saved to disk" ⇒ **误配置不响** | 2（note + config description） |

### 3.10 ✅ 本轮确认做对的（同样重要，别回退）

- **spill/fit 的幂等性**：`fitToolResult` 只依赖 stored part + `model`，不依赖时间或全局长度 ⇒ 同一会话每轮序列化一致，**跨轮不会自炸前缀**。这是"注入项影响 KV cache"这个老问题的正确解法，值得写进规范。
- **watchdog 设计**：GUI/TUI 看门狗是**传输级**（服务端每 10s 恒发 `server.heartbeat`，`handlers/event.ts:22-25`），所以 awaiting-permission / 问题 / 压缩 / 子代理 fan-out / 大 reasoning 这些合法静默期**都不会误触发**；服务端豁免按 pending tool 集合，等待权限发生在工具执行内、被覆盖。残余误判源只有 sidecar 全进程阻塞（见 3.9 最后一条）。
- **Electron 无新增凭据外泄路径**：`windows.ts:146-150/202-206` 三窗口 `contextIsolation:true / nodeIntegration:false / sandbox:true`；`Authorization` 头只在 `utils/server.ts:29` 按 sidecar baseUrl 装配，跨 origin 与跨源重定向均不带出（不进 query string）。**"不再统一改写 CORS" 是收紧不是放松**——原 `onHeadersReceived` 给所有响应盖 `ACAO:*`（含任意互联网响应与 sidecar 反射值），现由 `server/cors.ts` origin 白名单接管；`external-url.ts:3-8` 协议白名单 + `setWindowOpenHandler` 全 deny + `will-navigate` 守门。残余风险是渲染层 XSS 可读内存中明文密码，属既有设计非本次引入。
- §2.1 的修法**主动避开了已否决路线**（拆 `timeoutTimer`/`killTimer`、显式不加缺省值、回归用例只给 timeout 不给 abort）；`MAX_ATTACHMENT_BASE64_BYTES` 对齐 `read.ts` 的 `MAX_PDF_BASE64_BYTES` 且把线画在源头。这两处的判断质量高于上一份报告给的建议。

---

## 四、制度性发现：新模型注册需要 14–16 张表，自动校验为 0

新增一个模型必须同时改：`provider.ts:1271 CNY_PRICING`、`:1340 VISION_CAPABLE_MODELS`、`:2059 priority[]`、`:1969 getSmallModel`、`:36 shouldUseCopilotResponsesApi`、`plugin/codex.ts:29 ALLOWED_MODELS`、`transform.ts` 的 5 个 effort 分发器、`transform.ts:1601 options()`、`tool/freeform.ts:63`、`session/system.ts:56` + `prompt/<族>.md`、`prompt.ts:1565` step 压缩铁律门、`system.ts:42/49` flash/step 锚判据、**`~/.redcode/dcp.jsonc` 两张表（不在仓库）**、`seed/redcode.home.jsonc` 及其 live 镜像（`seed:182` 注释自承"两处必须保持一致" = 人肉）。

**实测校验：`grep -rln "CNY_PRICING\|ALLOWED_MODELS\|VISION_CAPABLE_MODELS" packages/*/test` → 0 命中。没有任何跨表齐备性断言。** 已有闸门只有 version / control-bytes / openapi-drift / subprocess-timeout / home-scripts-orphans 五个。

本轮就为此付了两次账，且是同一个模型家族：
- **gpt-6 只进了 `openai/gpt-6-{astra,luna,sol}` 一家**，而同一文件里 `gpt-5.6-luna` 是 `opencode-go` 与 `CNY_PRICING.openox` **两个 provider 都进表**；
- **step-5-preview 进了 seed 但 dcp 阈值表不随仓库走**（§3.3）。

**这一条比它看起来更重要**：本仓每轮版本都要接 2–4 个新模型，而注册完整性 100% 依赖人记住 14–16 个位置。`§3.3` 的静默回落是这条制度缺失的第一个严重事故，不会最后一个。

---

## 五、修复排序

### 第一梯队：现在正咬人，或加一道自动闸门让它自己咬人

| # | 动作 | 条目 | 兄弟数（改完复查） |
| --- | --- | --- | --- |
| 1 | `Binary.search` → `searchBy` 全量迁移：session 数组 4 处 + parts/permissions/questions 8 处；**并加一条闸门**：`grep -rn "Binary.search(" packages` 命中数不得增加（现 34），或直接删掉 `binary.ts:2-19` 逼所有调用点显式声明比较器 | §二 / §3.6 | 34 |
| 2 | `seed/` 出 `dcp.jsonc` 模板 + 启动时比对已装配模型与 `modelMinLimits` 键并 warn | §3.3 | 2 张表 |
| 3 | `tool.ts:155` 短路判据改 `outputPath !== undefined`；`attachmentRequestTokens` 非图片给下界 + `fitToolResult` 加统一条数线 | §3.1 / §3.2 | 6 工具 / 2 道门 |
| 4 | `all[]` 语义收窄成只装文件标签（`DEFAULT_SESSION_TABS.all = []`、migration 剔除、`openedTabs === all` 使 filter 退化），**同步改 `layout.test.ts:89-101` 的断言** | §3.4 | 4 过滤点 |
| 5 | `writeTimelineCache` 的 handle 与 key 同源（用 `:2048` 的 `v.session`，删三个模块级 `let`） | §3.5 | 3 |
| 6 | **新模型注册齐备性测试**：给定模型目录，断言 14–16 张表的键集合一致 | §四 | 一次性消灭整类 |

### 第二梯队：纪律与残留

7. 模型可见改动四问**变成可机检**：`prefix-shape.ts` 已能量各路由首段字节，接一个 CI 步骤对 `session/prompt/*.md` 的改动自动报 Δ 并断言 commit message 含四问小节。本轮 8 个 commit 只有 2 个答满（§3.8），靠自觉已被证明不成立。
8. 同步 `2026-09-11-skill-description-budget.md:11` 与 `config.ts:327-333` 的失效承诺（§3.9 末行）。
9. SSE 补拉失败接 toast + 降级 force refresh；`directory-sync.ts:545` 的非挂载会话回填；GUI/TUI 阈值统一并加频率上限（§3.9）。
10. spill 写盘改 `writeFileStringAtomic`、判龄失败偏向保留、会话删除清 spill、spill 侧同等 redact（§3.9）。
11. `image-tokens.ts` 定价表按 `model.api.npm` 分 5 provider（§3.9）；`transform.ts` 5 个 effort 分发器共用一张 family 表（§3.9）。
12. `working: () => true` 改为传 `shouldAnchorBottom`；`readTimelineCache` 的 memo 内 delete 拆成纯读 + 显式 invalidate；400/100/200/40/60 与 `contain-intrinsic-size` 收成一个共享常量（§3.7）。
13. `session/prompt/shared.ts:22` 与 `file/protected.ts:4` 等 27 处 `os.homedir()` 收进 `REDCODE_TEST_HOME`。

### 第三梯队：上一份的未动项，换一种交付方式

14. §6 六条工程卫生项（`bun.lock` / 发布链死引用 / `llm` 的 7,006 行测试从未跑 / LAN 静默密码 / oxlint 全 warn / 门禁只在本地）**不再作为"待办清单"提交**——它们已在阻塞路径之外躺了 6 天。改交付为：**每条各一个可独立 merge 的小 PR，且优先做那三条"加了就会立刻变红"的**（`bun.lock`+`--frozen-lockfile`、`turbo test:ci` 缺 junit 即红、`oxlint --deny-warnings`）。红起来才算落地。
15. §4.1 `event(aggregate_id, seq)` 索引、§4.5 `session(project_id, time_updated)` 索引、§4.2 metadata 双写与无帽：三条都是零行为变更 + 一条 migration，可打包一次做完。注意 `edit.ts:333-338` 的双写**本轮仍未修**，且它现在被 §3.2 的 0 价放大（metadata 不过预算）。

---

## 附：复核记录（口径与上次一致：子审计数字主 agent 独立复测）

| 声称 | 结果 |
| --- | --- |
| `Binary.searchBy` 1 个调用点 / `Binary.search` 34 处 | ✅ 主 agent 实测 `grep`：`searchBy` 仅 `sync.tsx:351`；`Binary.search(` 34 处 |
| session id 降序编码 | ✅ `core/src/session.ts:10` → `Identifier.descending()`；`id.ts` `now = ~now` |
| `compareTime` 时间升序排序 session 数组 | ✅ `server-sync.tsx:376` + `:375` 注释 |
| `seed/` 无 dcp 模板 | ✅ `find seed -name 'dcp*'` = 0；`seed/*.jsonc:12` 自陈分机本地维护 |
| 无跨表齐备性测试 | ✅ `grep -rln CNY_PRICING\|ALLOWED_MODELS\|VISION_CAPABLE_MODELS packages/*/test` = 0 |
| `GPT6_FAMILY_RE` 只在 2 处、4 个分发器仍 gpt-5 | ✅ 实测 `transform.ts:960/:1601` vs `:969/:977/:997/:1177` |
| `tool.ts:155` 短路 + 9 个工具带 `truncated` | ✅ 读 `tool.ts:155` 原文；`grep -rln truncated src/tool/*.ts` = 9 文件 |
| `image-tokens.ts:112-114` 非图片计 0 | ✅ 读原文（含其自陈理由） |
| `MAX_ATTACHMENTS` 仅 MCP 一处 | ✅ `grep -rn MAX_ATTACHMENTS src` = 3 命中，全在 `session/tools.ts` |
| `event-reducer.ts` 17 处 `Binary.search` | ✅ 实测 17，逐行号见 §二/§3.6 |
| `layout.tsx:109/:115` 把 system id 写进 `all[]` | ✅ 子审计给号，主 agent 未逐行复测（**inferred-to-verified 依赖子审计读码**），但 `layout.test.ts:89-101` 断言 `all == ["context","outline"]` 与之自洽 |
| 各路由 system 首段字符数（gpt −3720 / step +5517） | ⚠️ 子审计测量，主 agent 未复测；`default.md` 6729 未变与其"四问纪律"结论一致 |
| Electron 无凭据外泄新增 | ✅ 读 `windows.ts:146-150/202-206`、`utils/server.ts:29` 口径一致；结论为"未引入新问题"，非"绝对安全" |
| `reuse()` 2N 次 `key()`、TUI 零节流、`bun.lock` 未纳管、LAN 静默、oxlint 全 warn、死引用 6 处、`llm` 无 `test:ci`、canary 双空 catch、无 VACUUM、`event` 零索引、metadata 双写 | ✅ 全部由主 agent 在 HEAD 直接复测（见 §一 记分牌） |

**未验证 / 能力边界**：`~/.redcode/dcp.jsonc` 与 live DB 均在授权工作区外，本次无法直接读取——§3.3 的"新机零告警回落 50k/100k"结论来自 DCP 源码路径（子审计读 `RedCode-dcp/lib/...`）与仓内三次同因事故记录，非我在真实新机环境复现。§3.9 的 `image-tokens.ts:26-33` 定价表影响是按 Anthropic 公开像素/750 公式估算，未实测账单。

---

## 六、Karina 独立核验（260924）

以下对照当前工作树复核。正文中的源代码观察尽量保留；本节修正的是结论边界、证据强度与修复顺序。

### 可进入优先修复队列

| 原条目 | 独立核验 |
| --- | --- |
| §3.1 工具结果预算旁路 | **确认，但“既不 fit 也不 spill”说过头。** `tool.ts:155-157` 只要 `metadata.truncated` 已定义就跳过写入侧 `truncate.result()`，包括值为 `false`；`read.ts:503-516` 正常返回附件时确实会带 `truncated: false`。但 `message-v2.ts:903-915` 仍会在回放时运行纯函数 `fitToolResult()`。真实缺口是写入侧预算/可恢复 spill 被跳过，回放只能丢附件，不能替它们落盘。修复应以确实存在可恢复 spill（例如有效 `outputPath`）作为短路依据，并覆盖 `truncated: false` 与无 spill 的用例。 |
| §3.2 非图片附件计 0 | **确认预算洞；原由需要收窄。** `image-tokens.ts:112-114` 对非图片附件计 0，且回放侧也复用这条规则。5 MiB/32 条只由 MCP 入口 `session/tools.ts:29-43` 提供；`read.ts` 一次只返回一个受文件字节上限约束的附件，插件工具则可返回多附件。不能把 MCP 的条数上限当成所有生产者的共同保证。吸收“非图片附件不能零价且无总量约束”，但**不要直接按 base64/4 给 PDF 计 token**；应在共享边界设硬字节/数量上限，或按实际模型的文档输入语义估价。 |
| §3.4 `SYSTEM_TABS` 与 `all[]` | **确认。** `layout.tsx:109-116` 默认把 `context` 放进 `all`，打开其他系统 tab 也会追加；`:934-950` 的 getter/setter 只过滤 `review`。迁移 `:223-240` 只做类型清理与路径规范化，没有剔除系统 tab；`layout.test.ts:89-109` 则把 `context/outline/plan` 留在 `all` 写成期望值。应先修纯状态转换与持久化迁移，再改这些测试。 |
| §3.5 Timeline cache 会话归属 | **源码级身份错配成立，视觉后果未在本轮复现。** `message-timeline.tsx:726-740` 在切换时把新会话 key/row keys 与当前 `virtualizer` 一起写入；该 handle 可能仍属于旧会话。缓存同时保存传入的 keys 与 `handle.cache`，因此 `cacheReusable()`（`message-timeline.data.ts:167-175`）可能用新 keys 验过旧 cache。应补 A→B→A 的缓存归属回归，再改成 key 与 handle 绑定到同一虚拟器实例。 |
| §二、§3.6 二分查找 | **只确认 session 列表这一类。** `SessionID` 使用降序 ID（`packages/core/src/session.ts:7-11`），而 `server-sync.tsx:371-376` 按 `compareTime` 升序存放；`event-reducer.ts:176-229` 却按 ID 字典序二分，比较器与数组不相容。现有测试用 `"a"`/`"b"` 一类 ID，未覆盖真实编码与生产排序。按各数组的不变量逐处修；当调用方只有 ID、数组按时间排序时，线性按 ID 定位比盲目换成 `searchBy` 更直接。 |
| §3.3 DCP 缺键告警 | **空表静默成立，但“当前完全无告警”已过时。** DCP 已有 `detectModelLimitMiss()`：阈值表非空、模型键缺失时会每会话告警（`RedCode-dcp/lib/messages/inject/utils.ts:108-147,150-182`）；表不存在或为空时仍跳过检测。吸收“高上下文模型遇到空表仍会静默回落”，在现有 DCP 告警处补空表情形/测试。DCP 配置是机器级配置，不建议按原文直接加进主仓 `seed/`。 |

### 不应照搬的归纳与修法

- **“34 处 `Binary.search` 都有同一缺陷”未成立。** session ID 是降序；但 Message/Part、Permission、Question ID 的生成路径是升序（`packages/opencode/src/session/schema.ts:13-22`、`permission/schema.ts:11`、`question/schema.ts:8`）。权限与问题列表由空列表开始，再按 ID 插入；parts 还有 reasoning 优先的分组顺序（`packages/app/src/context/directory-sync.ts:26-30,105-119`）。这些数组须各自核对排序/初始化路径，不能用“同一个降序时间 ID”一概而论。`searchBy` 也只有在能提供与数组排序一致的目标键时才适用。
- **§四应吸收“模型接入需要自动覆盖检查”，不吸收“14–16 张表键集合必须一致”。** 价格、视觉能力、推理档位等表是条件性数据，不能要求键集合机械相等；测试应按模型能力/路由声明检查必需项与禁止项。
- **§3.8 的字符/token 与缓存影响数字本轮未复测。** 报告自身也指出 GPT 统计漏了工具 schema 一侧。复用这些数字或据此改排序前，需用 `prefix-shape` 重算包含工具 schema 的完整变化。
- §3.7、§3.9 的 SSE、消息窗口、spill 隐私/回收等多子系统结论本轮没有逐条复现，保留为候选调查，不据此直接提级为已确认缺陷。

### 修订后的吸收顺序

1. 先补工具结果写入侧预算与可恢复 spill 的统一行为，同时明确非图片附件硬上限。
2. 修复 `sessionTabs.all` 只代表动态文件 tab 的状态不变量与旧状态迁移。
3. 修复按时间排序的 session 数组上的 ID 查找；只扩展到经逐项验证确实排序不兼容的调用点。
4. 给 Timeline cache 加跨会话归属测试，并保证缓存 key 与 Virtualizer handle 同源。
5. 在 DCP 已有告警机制中覆盖阈值表为空/缺失；另建按模型能力条件化的注册完整性测试。
