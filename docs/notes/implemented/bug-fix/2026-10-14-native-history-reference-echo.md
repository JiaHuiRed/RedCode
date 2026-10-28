# 流式期可见 `[History reference: msg_…]` 后缀：native 标记被复述，而流式剥离是空操作

状态:implemented（A + C 已落地，B 待观察）

## 261028：改写形连续复述与历史回灌

- `ses_ffe5e7fab84e1ffeuBgP613x55uKst` 的助手文本中出现连续
  `[Historical reference: msg_…]`，之前只识别 `History reference`。流式与收尾规则补上改写形，
  并暂扣跨分片的候选前缀；代码引用仍保留。
- 已落库的助手回声会在后续请求的历史中再次出现。原生压缩出站投影先净化助手 text 的两种
  引用回声，再投影压缩块并附加正常引用；用户消息、代码引用与持久化数据不变。
- 现场 13:34:05 一段重复标记后，13:34:07 紧接真实 `edit` 工具调用，直接掐流会砍掉
  在途工具。与哥哥确认取舍后落地「中止并重试」：同一 text part 内连续闭合 ≥3 个
  引用标记（阈值对齐 NgramDetector 的 3 次判定）且 `toolsStarted=false` 时停止当前流
  （`referenceLoop` 进 `Stream.takeUntil`），清掉本次 attempt 落库的 part 自动重试一次；
  重试仍复述则写入一句固定可见说明并以 stop 结束本轮。工具已开始的 step 只剥离不触发，
  在途调用不受影响；标记之间夹正常正文即重新计数。
- 模型可见面：仅含已落库回声的助手历史正文发生删除；固定前缀增量为零，但从最早被净化的
  历史位置开始 KV 前缀失效一次。新增一段有界固定说明文案（约 45 字，processor.ts 重试
  耗尽分支），仅在两次请求都复述时出现在该轮助手正文尾部；输入由原始消息与确定性投影
  可重建，无其他新增注入项。

## 落地记录（261014）

按诊断时的建议次序落地 **A + C**（都不动模型可见面），B 暂不加：

- **A · 不再标注当前 user 轮**（`native-context.ts:10-31`）：`annotate()` 末条消息为 user 时原样返回，历史消息的引用标记保留（`context_read` / `context_search` 仍靠 msg ID 回读）。请求体每轮少一段合成文本。
- **C · 流式纠偏**（`processor.ts` text-delta 分支 + `instruction-echo.ts` 新增三个纯函数）：
  - `leakAnchorStart(text)` —— 锚点在累积文本里的起始下标（scanner 只回答"有没有"，纠偏需要"从哪切"）；
  - `cutAtLeakAnchor(text)` —— 按锚点起点截断，**不要求闭合 `]`**，返回保留正文 + 从锚点起的暂扣缓冲；
  - `releaseLeakHold(hold)` —— 暂扣缓冲里出现闭合 `]` 时丢掉标记本体、放行其余；
  - processor 改为**先扫描再落笔**：锚点命中的那条 delta 不再推给客户端，截断后的整条 part 立刻 `session.updatePart` 下发；暂扣期间的增量不进正文也不推送，闭合后放行并重新武装扫描器（同一 part 可能出现第二个标记）。
  - 同时删掉 trip 时的 `ctx.shouldBreak = true`（实证四：该位唯一读取点是权限拒绝分支，设它只会把后续权限拒绝误判成 blocked；断流也会砍掉紧随的工具调用）。
- **注释修正**：`instruction-echo.ts` 的 LEAK_ANCHORS / LeakAnchorScanner 注释里"命中即中断""命中即 shouldBreak"的表述已按实际行为改写。

**验证**：`instruction-echo.test.ts` + `native-context.test.ts` 56 pass / 0 fail（新增纠偏三件套单测 11 条、annotate 跳过末条 user 三条）；`processor-effect.test.ts` 新增端到端用例（24 字符分片注入半截标记）**先红后绿**——旧逻辑下 `mid-stream correction never reached the client` 超时失败，新逻辑下终态正文为"先说结论：已经修了。收尾一句。"且客户端 delta 全程不含标记；三文件合计 75 pass / 0 fail。

**未做**：B（prompt 层禁令）按原计划视 A 的复述率再决定；未做真实供应商试跑，未做 GUI 视觉冒烟（纠偏通道 TUI 的 `message.part.updated` 整体替换与 GUI 的 invalidate+重取两条路径都通，但需要重编重启后实测）。

## 问题

哥哥 GUI 实测（截图两帧，会话 `ses_ffe5ec82e1cfbffenS07cSd250K3mt`，目录 `D:\KLX\CWB\financialcost`，0.12.9）：

- **渲染期**：助手正文尾部多出一行 `History reference: msg_001a1390917e9001YSr6HTGtsVdg4a`（截图里首尾方括号不易辨认，按请求体与剥离正则的判据实际形态是 `[History reference: msg_…]`），与紧随其后的 `~ Reading file...` 同屏；
- **完全输出后**：该行自行消失，同一条消息里只剩正文与 `Read app\db.py [limit=25, offset=496]`；
- **怀疑**：恢复原生 compaction 之后引入的回归（DCP 时代没见过）。

排查结论：**标记确实是 native compaction 引入的，但"渲染期可见"这条缝在 DCP 时代就存在**——当时漏的是 `<dcp-message-id>` 那类（260803 实测 `<m0364</m0364>`），只是形状不像人话、频率低。本次是同一类病（模型把"给它看的"当成"要输出的"）在新标记形状下被放大：标记是 `[History reference: msg_…]`，**与消息本身同形**，且被追加到出站副本的**每一条**消息上。

诊断期间未改任何代码，全部为只读取证。修复方案见「决策」。

### 取证口径

- **库**：`~/.redcode/data/redcode.db`。注意 `~/.local/share/redcode/redcode.db` 是 2026-06-17 的陈旧副本（该会话在其中 0 命中），**别拿它下结论**。
- **日志**：`~/.redcode/data/log/dev.log`（当前 GUI 进程）、`2026-10-14T082820.log`（早间同一会话）。
- **截图对应 part**：`prt_001a1390912cc001BV4KtQJ9tkpF6r`（消息 `msg_001a1390909120013NLbF9dq804dyp`）。

### 实证一：落库面是干净的，脏的只有流式增量

该会话 53 条消息 / 172 个 part，`part.data like '%History reference%'` **0 命中**；截图那条正文 part 落库为 **122 字符纯正文**（`注册点清楚。写 _migrate_base_aliases，挂在 _migrate_base_code 后面…确认收尾形态。`）；该会话 `synthetic=true` 的 part **0 条**（`annotate()` 只改出站副本，从不落库）。→ **标记从未落库，只在流式期间存在于客户端**。

同一会话的残留指纹：86 个 text part 里 **36 个落库为空**（`"text":""`）。抽查 6 条触发过的消息，trip 于 `textLen=23/28/23` 的三条其 text part 全部为空（标记独占一个 part 被整段剥空），trip 于 `textLen=53/86/129` 的三条则保留了 25/63/105 字符正文（标记挂在正文尾部）。

### 实证二：时间线逐帧对得上截图（`dev.log`）

```
14:10:56        process 开始（messageID=msg_001a1390909120013NLbF9dq804dyp）
14:10:58        llm.ttft ms=2440
14:10:59        WARN leak.dcp-reminder  textLen=146          ← 流式拦截器命中
14:11:01.149    tool part 创建（Read app\db.py limit=25 offset=496）← 先渲染出来
14:11:01.675    WARN instruction.echo kinds=native-history-reference  ← part 重写，标记消失
```

工具调用比剥离**早出现 0.5 秒**，与截图"标记与 `Reading file...` 同屏"完全一致。146 = 正文 122 + 24。

### 实证三：trip 时刻的剥离必然是空操作（已实跑复现）

`instruction-echo.ts:102` 的 A 类正则是 `/\[History reference: [^\n]*?\]\s*/g`——**要求闭合 `]`**。而 trip 命中时标记还没闭合：

```
$ 输入 detect(正文122 + "[History reference: msg_")
   kinds: []          strippedLen: 146   unchanged: true
$ 输入 detect(正文122 + "[History reference: msg_001a1390917e9001YSr6HTGtsVdg4a]")
   kinds: ["native-history-reference"]    strippedLen: 122   clean: true
```

本会话 19 个 trip 的 `textLen` 取值（23 / 24 / 28 / 50 / 51 / 53 / 54 / 56 / 72 / 86 / 95 / 110 / 113 / 122 / 129 / 146 / 260 / 870 / 2584）**全部等于 `正文长度 + 24`**，即每次命中的都是标记所在的那个 24 字符分片（`[History reference: msg_` 恰为 24 字符），标记最长只到第 24 个字符，而完整标记需要 54 字符。→ **trip 时 `detect()` 恒返回 `kinds: []`，只把 `leakTripped` 闩上，实际一个字都没剥**；完整标记只在 `text-end` 被剥（`processor.ts:964` → `:992` 的 `updatePart`）。

> 该结论依赖分片粒度：本 provider 是 24 字符/片，故必然不完整。分片更大的 provider 有可能整条标记落在一片里——但即便剥离成功，**客户端仍然看不到纠偏**（见实证五），症状不变。

### 实证四：`shouldBreak` 对流不生效，"命中即中断"不成立

- `processor.ts:1140` 的 `Stream.takeUntil(() => ctx.needsCompaction || ctx.reasoningStallTripped)` —— **没有**泄露标志位。
- `ctx.shouldBreak` 全仓唯一读取点是 `processor.ts:328`（权限拒绝分支）；`:943`（ngram）与 `:955`（泄露）两处赋值无人消费。
- `instruction-echo.ts:66` 注释写"命中即 `leakTripped` + `shouldBreak`，不会再有下一条"——前半句对（`leakTripped` 确实闩住扫描器），后半句与实际不符。

所以 260812 注释里的"命中即中断+剥离，防止 GUI 无限刷屏"在代码上只兑现了后半截，且这一截在标记不闭合时也不成立。

### 实证五：客户端只有追加、没有纠偏

TUI `context/sync.tsx`：

- `:459-475` `message.part.delta` → `part[field] = (existing ?? "") + delta`，**纯追加**；
- `:438-457` `message.part.updated` → `reconcile(part)`，**整体替换**。

引擎只在 `text-end` 下发整条 part（`processor.ts:992`），此前没有任何纠偏通道。→ 已推送的 delta 无法撤回，屏幕上的标记要一直挂到 part 收尾。这条与 `processor.ts:945-948` 自己的注释（"已推送的 delta 无法撤回"）一致，是已知边界。

### 实证六：模型侧根因——标记与消息同形，且挂在出站副本的每一条消息上

`native-context.ts:10-30` 的 `annotate()` 给**每条**出站消息追加一个 `synthetic` 文本 part `[History reference: ${message.info.id}]`（仅跳过 `delivery === "queued"` 的用户消息），调用链 `prompt.ts:1445 → native-context-runtime.ts:34-39 → annotate`，**每个 step 都跑**。

解析日志里一条真实请求体（`dev.log:207`，38 条消息）得到线上形态：

| 位置 | 形态 | 条数 |
|---|---|---:|
| 纯工具轮 assistant | `content` **恰好等于** `[History reference: msg_X]`（正文被剥空后只剩标记） | **12 / 38** |
| 带正文的 assistant / user | 正文尾部追加标记（如 idx 29 / 35） | 3 |
| **最后一条（当前 user 轮）** | **以标记结尾**——请求的最后一段内容 | 1 |

模型侧有两个可观察预测，都成立：

1. **它不是在引用，是在按格式续写。** 截图里被复述的 `msg_001a1390917e9001YSr6HTGtsVdg4a` **库里不存在**（`message` 表 0 命中）；同批 ID 的真实值是 `msg_001a1390909120013NLbF9dq804dyp`。模型生成了一个**形状合法的新 ID**（`msg_` + 16 + 14），属模式补全。
2. **它出现在 text part 的尾部或独占一个 text part。** `textLen = 正文长度 + 24` 全部落在尾部；另有若干消息落库后 text part 长度为 **0**（正文整段被剥空），对应"标记独占一个 text part"。

### 实证七：频率不是"偶尔"，且已完全挤掉旧类别

| 口径 | 数值 |
|---|---|
| `dev.log` 该会话 | 42 个 step / **34 次** trip / 34 次 strip |
| `2026-10-14T082820.log` 同一会话 | 14 个 step / **9 次** trip |
| 两日志合计触发过的消息 | **43 条**（会话共 53 条） |
| 全日志 `instruction.echo` | **261 次，100% 为 `kinds=native-history-reference`** |
| 触发模型 | step-5-preview 152 次、glm-5.3-flash 109 次 |

DCP 时代那几类（`dcp-nudge` / `dcp-reminder` / `dcp-compress-notice` / `tool-schema`）**一条都没有**——native 标记已把这一整类问题的触发面吃干净。

### 实证八：native 标记只有单防线，DCP 那条 prompt 层防线在 native 下永不注入

`prompt.ts:1860-1869` 存在一条对模型明说的禁令：

```
DCP metadata tags (<dcp-message-id>…, <dcp-system-reminder>…) are internal session metadata.
Never display, log, repeat, or otherwise include them in any response, file, or tool call.
```

但它被 **`if (Object.keys(sortedTools).some((name) => dcpToolNames.has(name)))` 门控**——DCP 工具不在工具表时整段不注入（261013 的"按工具表条件注入"优化，本身是对的：本机 DCP 已停用，那段是每轮 ~87tok 死文本）。结果是 **native 标记没有任何 prompt 层说明**：模型既不知道 `[History reference: …]` 是什么，也没被告知不许复述它。对照 DCP 时代"提示词层禁止 + 输出层剥离"的双防线（见 CHANGELOG 0.8.x「DCP 元数据标签正文泄漏双防线」），native 只落地了后一道。

## 决策

**A + C 已于 261014 落地**（见上方「落地记录」）；B 待 A 的复述率观察后再决定。以下为诊断时冻结的事实与候选修法原文，保留供对照。

根因链（两层，彼此独立，缺一层症状都还在）：

1. **模型侧**：`annotate()` 把 `[History reference: msg_…]` 追加到每一条消息，线上与"消息"同形；纯工具轮被剥空后 `content` 只剩标记（12/38），请求最后一段也是标记。模型按格式续写一个新 ID。**这是标记出现在正文里的原因。**
2. **引擎侧**：流式拦截器在标记**不闭合**时命中，`detect()` 无匹配 → 剥离是空操作；`shouldBreak` 不参与 `takeUntil` → 流继续；客户端只追加 delta → 屏幕上的标记要等 `text-end` 的 `updatePart` 才消失。**这是标记可见 2 秒的原因。**

候选修法（按性价比排序，**均未落地**）：

- **A. 不再标注最后一条（当前 user 轮）。** `planAutomatic`（`native-context.ts:75-81`）本就把 latest user 当压缩边界保护，它的标记没有消费方，却正好是模型续写的靶子。改 `annotate()` 一行，零模型可见增量（净减少一段合成文本）。
- **B. 补 prompt 层第二道防线。** 对齐 `prompt.ts:1860-1869` 的 DCP 禁令，为 native 标记写一段同形说明（"`[History reference: msg_…]` 是引擎内部引用，永不输出"）。**属模型可见改动**，需按四问评估：① 新增固定前缀一段（约 100 字符 ≈ 25tok，逐字节稳定、随模型不变）；② token 增量即该段；③ 前缀一次性失效后稳定，`revision` 不动；④ 新增注入项 1 段。
- **C. trip 时下发纠偏。** 命中即按"标记起点"就地截断（不要求闭合 `]`），立刻 `session.updatePart` 推一条整条 part；后续属于标记的增量暂扣到 `]` 出现再放行。客户端一帧内不再显示。改动集中在 `processor.ts:951-956` + `instruction-echo.ts`（补一条"不闭合也认"的截断正则）。
- **D. 不建议把 trip 接进 `takeUntil`。** 断流确实能兑现注释里的"中断"，但本标记**总在 text part 末尾、后面紧跟工具调用**（实证二：Read 就在 2 秒后），断流会把工具调用一起砍掉，属治错方向。

建议次序：**A + C** 先落地（A 治发生源、C 治可见窗口，两者都不动模型可见面），观察复述率；B 视 A 的效果再决定是否加一段固定前缀。

## 备选与否决理由

- **"这是渲染层回归"**：否决——落库 0 命中（实证一），标记来自模型输出而非渲染管线；TUI 的 delta 处理是朴素追加（实证五），没有可回归的渲染逻辑。**但要说清边界**：native compaction 确实是这件事的**触发源**（DCP 时代没有这种形状的标记），所以"恢复原生 compaction 之后才见到"这个观察是对的，只是因果不是"渲染坏了"。
- **"DCP 时代完全没出现过，所以是新问题"**：部分否决——同一类病在 DCP 时代有实测记录（CHANGELOG「DCP 元数据标签正文泄漏双防线」，实测 `<m0364</m0364>`），当时的防线是"提示词 + 剥离"两条。本次是 (a) 标记形状更接近人话、(b) 频率从偶发涨到 81% of steps（实证七）导致被看见。**"以前没见过"是频率差，不是机制差。**
- **"把 `[History reference: …]` 换成不含 ID 的弱标记（如 `[ref]`）就没事"**：否决——标记的作用就是让模型能引用 msg ID（`context_read` / `context_search` / `context_restore` 的入参），弱化即废掉功能。要降的是"与消息同形"这一点，不是可读性。
- **"让模型别输出就行了，不用改代码"**：否决——模型不输出靠的是 prompt，而 native 标记当前**没有任何 prompt 层说明**（实证八）；即使补上（候选 B），历史记录里已存在大量同类复述，且 prompt 层从来是"降低概率"而非"保证"，输出层兜底不能撤。
- **"把 trip 时刻的剥离改成非贪婪到行尾即可"**：不够——只解决"内存里剥干净"，客户端仍拿不到纠偏（实证五），屏幕上的标记照样挂到 `text-end`。必须与下发整条 part 同时做（候选 C）。
- **回退到 DCP**：否决——`implemented/feature/2026-10-10-native-compaction.md` 已定整合方向（消插件维护、账本/投影/提交/预算边界），且 DCP 那套标记同样会泄漏。要修的是标记的注入形状与流式纠偏，不是换回插件。

## 后果

- **识别签名**（防复发，261014 更新）：修复后 `leak.dcp-reminder` 仍在 trip 时刻打点，但 `textLen` 等于**截断后**的长度（与最终落库长度一致），其后不再紧跟 `instruction.echo kinds=native-history-reference`（流式已纠偏，text-end 的 `detect()` 是空操作）。**若又见到 `textLen` 恒等于"落库长度 + 分片粒度"、且 2 秒后出现 `instruction.echo`，说明纠偏没生效、回到了旧行为**；落库出现 text 长度 0 的 text part 同样是标记独占一片的旧指纹。
- **取证坑（必须记住）**：本机有两个 `redcode.db`，活跃库是 `~/.redcode/data/redcode.db`；`~/.local/share/redcode/redcode.db` 是 2026-06 的陈旧副本，查它会得出"该会话不存在"的假结论。
- **数据边界**：本次未对"剥离是否误伤真实正文"做穷举——`OWN_BLOCKS` 的全局替换 `/\[History reference: [^\n]*?\]\s*/g` 会吃掉正文里出现的同形字符串（例如用户讨论这个机制本身）。当前判据只有"锚点是引擎独有措辞"。C 落地时补了流式侧的负例（`instruction-echo.test.ts` 的"不误切"用例与新增的 `leakAnchorStart` 定位用例），但 `detect()` 整段剥离路径的负例仍只有 DCP 侧那一条（`:89-91`），native 侧的同类负例待补。
- **同族未修项**：`processor.ts` 的 ngram 分支仍在设 `shouldBreak`（同实证四）。泄露分支的标志位已删，ngram 那处未动——它的语义（复述循环）与本标记不同，是否接进 `takeUntil` 要单独判断。
- **回链**：`native-context.ts:10-31`（annotate 头注释）、`processor.ts` text-delta 分支、`instruction-echo.ts`（LEAK_ANCHORS 与三个新函数）均已回链本文件；CHANGELOG 条目同链。
- **代码引用**：`native-context.ts:10-31/75-81`、`native-context-runtime.ts:34-39`、`prompt.ts:1445/1860-1869`、`processor.ts`（text-delta 分支 / `:328` / text-end / `takeUntil`）、`instruction-echo.ts`（LEAK_ANCHORS、`leakAnchorStart` / `cutAtLeakAnchor` / `releaseLeakHold`、`detect`）、TUI `cli/cmd/tui/context/sync.tsx:438-475`。
