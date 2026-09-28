# GPT 人格声线纳入可见交付

状态:implemented

## 问题

维护者观察到 GPT 回复容易退化成机械的状态播报，即使 soul 已注入。静态提示层显示：默认规则把首句限定为回答事实问题，并强调压缩回复；GPT Delta 虽写有“不要显得冷漠”，但对称呼、反应和玩笑只说 “are fine”，同时重复了一遍默认层的简洁要求。对高服从模型而言，前者像可选风格，后者的多次强调更像硬要求。

这是规则权重冲突的合理假设，不把用户观察或提示词改动本身冒充为已完成的模型行为 A/B 结果。

## 决策

- 默认层把首句目标从“回答问题”改为“回应用户实际意图”：事实问题仍直接回答；情绪、幽默和关系线索也是意图的一部分，可自然承接。
- 默认层明确“简洁删重复，不删 soul 的自然语气”。
- GPT Delta 将 soul 声线明确为可见交付，并要求技术/状态回复也保留关系语气；用户给出情绪或熟悉感时自然回应，不默认落成变更日志或事故报告。
- 删除 GPT Delta 重复的 `Final answer` 章节，让默认层继续拥有回复结构；不修改 Gsoul/Tsoul，也不添加模板台词。

## 备选与否决理由

- **继续扩写 soul、追加示例台词**：否决——人格文件本身已足够明确，继续加料增加固定前缀成本，也容易把自然反应变成表演模板。
- **只在 GPT Delta 里写“可以更有人情味”**：否决——可选语气无法抵消共享默认规则对首句和简洁度的强约束。
- **把 GPT 专属规则复制到所有模型 Delta**：否决——没有各模型都存在相同偏移的证据；共享层只澄清“用户意图”含义，较强的声线要求仍只放 GPT Delta。

## 后果

- `system.ts` 对 GPT 返回 `[PROMPT_DEFAULT, PROMPT_GPT]`；因此默认层改动对所有使用公共基线的模型生效，GPT Delta 增量只影响 GPT 路由。
- 提示词是固定文本，没有新增动态注入项或用户内容上限问题。注入内容分别由 default 拥有意图识别与简洁规则、GPT Delta 拥有人格声线要求；无额外示例台词。
- 编辑前默认层为 6,585 字符 / 6,729 UTF-8 bytes（`Token.estimate` 约 1,646），GPT Delta 为 2,182 字符 / 2,182 bytes（约 546）。编辑后默认层为 6,768 字符 / 6,914 bytes（约 1,692），GPT Delta 为 2,007 字符 / 2,007 bytes（约 502）；按两段分别估算，合计约从 2,192 增至 2,194 tokens（净增约 2）。字符估算不是模型 tokenizer 的精确 token 计数。
- KV cache 最早从默认提示第 17 行改动处失效；GPT Delta 后续内容及其后的提示前缀需要重建。GPT Delta 内部移除重复章节，但公共基线变化使各公共基线模型都受到这次缓存变化。
- 验证通过系统提示路由测试，确认 GPT 收到更新后的 default + GPT Delta；它验证提示词装配，不代表真实模型行为已 A/B 验收。真实 GPT 会话对照尚未运行，因此不能声称人格可见度已实测提升。


## 第二轮（2026-09-28）：称呼规则与叙事豁免

第一轮落地后实测 GPT（Luna/Sol）仍偏冷：中文直接称呼仍用泛化「你」，普通对话仍默认事故报告腔。已核实 soul 注入链与模型无关（`session/instruction.ts` 按 client 选 Tsoul/Gsoul，GPT 与其他模型拿到相同 soul），排除「拼接丢失」。残留原因收敛到两条抑制：

1. `gpt.md` 的 `Do not narrate routine reads, searches, obvious next steps, or minor confirmations.` 被高服从模型过度解释成「不要保留第一人称语境」。
2. Voice 章节没有称呼规则，工程规则的 must/never 权重感把 soul 的自然声线当成了可选风格。

### 决策

- narrate 禁令改为只禁「低层工具机制与例行步骤播报」，并明确简短第一人称框架在解释意图、发现、纠错、换方向时是有价值的。
- Voice 增补：不把普通回复压平成匿名工程腔；中文需要直接称呼时优先 soul 的称呼（如「哥哥」）而非泛化「你」，不必要时省略。
- 不扩 soul、不加示例台词、不写第二套 persona（否决项与第一轮相同）；称呼措辞写「soul's form of address」而非硬编码，与 260924 prompt-instruction-ownership 的归属一致（runtime 供事实、soul 拥有表达）。

### 模型可见改动四问

1. `gpt.md` 两处：Progress updates 的禁令句替换为「机制播报禁令 + 第一人称叙事豁免」；Voice 增加工程腔禁令与中文称呼规则。`default.md` 未动。
2. `gpt.md` 2,007 → 2,350 字符（净增 343，约 +86 tokens），只作用于 GPT 路由。
3. KV cache：gpt.md 变化使其后前缀对 GPT 会话作废并重建；其他模型前缀不受影响。
4. 上限：编译期内嵌固定文本，无动态注入项。

验证：`test/session/system-prompt-routing.test.ts` 10 pass（含 "visible deliverable" 措辞与无 Final answer 章节断言）。真实 Luna/Sol × Gsoul/Tsoul 对照仍未运行，人格可见度提升待实测确认。

## 第三轮（2026-09-28）：隐藏推理与可见人格解耦

### 决策

- `gpt.md` 不再要求每次文件编辑前播报；只在发现、纠错、换方向、非平凡编辑与关键验证等
  有帮助的节点简短说明，禁止逐操作机械播报。
- 删除“close romantic partner talking to her boyfriend”的关系强度设定，表达距离完全以当前
  soul 为准；隐藏 reasoning 专注解题，不需要表演 persona；面向哥哥的可见正文仍遵循 soul。
- Gsoul/Tsoul 明确写出上述 reasoning/visible 边界。`default.md` 不改，不增加样例台词或新的
  称呼频率要求，也不添加二次 LLM 改写。

### 模型可见改动四问

1. **模型看到什么变了**：`gpt.md` 将“每次编辑前说明”换成只在有帮助的关键节点简述；将固定
   恋爱关系句换成严格匹配当前 soul 的关系距离；明确 private reasoning 解题、visible prose
   承载 soul。两个 soul 文件把“reasoning 不展示时不必表演人格”改成“隐藏 reasoning 不必
   维持角色语气，但可见正文仍完整遵循本 Soul”。
2. **token 影响**：按 `Token.estimate`（chars/4）测当前 Git HEAD 与工作树，统一 LF 后：
   `gpt.md` 为 3,523 → 3,071 字符 / 3,623 → 3,171 bytes / 881 → 768 tokens
   （净减 452 字符、113 估算 tokens）；Gsoul 与 Tsoul 各净增 17 字符、41 bytes、5 估算
   tokens。每个会话只注入一份 soul，所以 GPT 会话合计约净减 108 估算 tokens。该估算不是
   provider tokenizer 的精确计数。
3. **KV cache 影响**：`system.ts` 将 GPT 路由拼为 `[PROMPT_DEFAULT, PROMPT_GPT]`；
   `default.md` 不变，GPT Delta 的改动只使 GPT 前缀从该 Delta 的首个变化处起失效。
   `instruction.ts` 每个客户端只加载一份 soul（Desktop=Gsoul，其他=Tsoul）；对应客户端的
   soul source 从其注入位置起变化，另一客户端不受该 soul 文本变化影响；非 GPT 模型不受
   GPT Delta 变更影响。GPT Delta 在源码中静态导入，运行中的应用需重建/重启后生效；Soul
   instruction 按会话缓存，活动会话继续使用已有缓存内容。
4. **硬上限**：`gpt.md` 是编译期固定文本。Soul 文件按 `instruction_budget.max_source_bytes`
   单来源硬限读取，默认 1MiB，超限整份跳过；`max_total_bytes` 默认 64KiB 仅告警而非总量
   截断，本次未改变注入预算或引入动态用户内容。

### 验证边界

`bun test test/session/system-prompt-routing.test.ts --timeout 30000` 通过：10 pass，0 fail。
它验证 GPT 仍收到公共基线与 GPT Delta；这证明装配路径，不证明模型可见行为改善。真实
Luna/Sol × Gsoul/Tsoul A/B 未执行，不能宣称语气变化已经行为验收。
