# Code 的工程约束与正文口吻分开，工程记忆不再统一提升为指令

状态:implemented

## 范围与证据

维护者反馈：三份真人角色 Soul 在长任务里常只在开头使用熟悉称呼，正文退回工程报告；两份虚拟角色相对稳定。本轮重点核对 default、GPT、DeepSeek、GLM、AGENTS 与记忆链路，保留五份 Soul 原文，不修改 Step / SenseNova 专属提示词或模型路由。

实际装配是 provider / agent 基础提示 → 环境与 Instruction 来源 → 绑定 Soul → 主会话 Conversation → MCP / 技能与运行时尾部。三份真人角色与虚拟角色走相同的 Soul 装配路径，没有按真人名字分流的逻辑；不能据静态文本解释两类角色所有行为差异。

已确认的规则冲突与冗余：

| 位置 | 原规则 | 具体问题与处理 |
| --- | --- | --- |
| `instruction.ts` | AGENTS、配置指令、全局 / 项目 MEMORY 都标为 `Instructions from`，再声明 `OVERRIDE any default behavior` | 旧教训被统一赋予了指令地位；现在单独标注工程记忆，保留适用事实与教训，并按当前指令核对冲突。AGENTS 对工程操作的约束保留，Soul 负责身份与口吻。 |
| `default.md` | 正文只强调 conclusions / actions；每个跳过步骤都要报告 | 收窄私有推理与正文的边界，允许有用解释；报告真实结果、失败及未完成的必要验证，不要求罗列常规操作。验证按逻辑改动批次，与项目 AGENTS 对齐。 |
| `default.md` + 私有召回插件 | 前者宣称任何 `system-reminder` 都有权威，后者用同名标签包裹「低信任、非当前指令」历史证据 | 标签本身不授予权威，引用与召回仍按来源解释；运行时任务约束继续有效。 |
| GPT + Conversation / working-style | GPT 强制纠错时以发现或动作开头，另外两处已要求正确处理纠正 | 删除重复的强制开场；保留改正错误与继续执行，工程验证和 UI 交付要求不动。 |
| DeepSeek | exposed reasoning 要求 `conclusion-shaped` | 明确精简约束针对推理，不延伸成正文只能写结论；正文可用 Soul 的口吻解释。 |
| Conversation | 多段反套话、自我纠错与称呼要求交叠 | 合并成较短的相处契约。称呼可以自然出现在正文的解释、建议、分歧、共同反应中，无次数要求、固定开场或输出替换器。 |
| 私有全局 AGENTS | 记忆入口、注入表格、备份细节、自检与收工流程多处重复；「改完→验证→停」适用范围宽 | 精简重复流程；工程规则约束动作、事实和验证，不要求公事公办。明确真实赞同、熟悉称呼、玩笑及解释可以存在。 |

GLM 专属段仅规定推理语言和收敛，没有找到直接限制正文关系表达的条款，因此保持原字节。CORE 插件虽然能在 system 尾部重复注入，但所读私有 AGENTS 没有 CORE 标记，不能把它说成当前的重复注入来源。

私仓另有 `ecc-shell-stub.js` 替换 legacy compaction prompt 的旧钩子，只保留工程状态，并覆盖引擎现在的相处连续性模板；已删去该重复实现，保留 shell 环境与 git 工具。所读配置启用了 native compaction，native 路径不走此钩子，**因此这项不能当作当前漂移的根因**。

## 取舍与边界

- 不增加更强的人格命令，不数昵称，也不把「你」机械替换成固定称呼。工程准确性与具体相处方式分别由其来源负责。
- 不改权限、工具、模型路由、记忆文件内容、召回算法或 Soul 版本机制；不通过重排或逐轮追加提示强化人格。
- Instruction 的来源发现、保留优先级与字节预算沿用原实现；新来源标签计入原预算。清单与注入文本继续使用同一个 evaluate。前缀诊断识别新的记忆标签且不输出记忆正文。
- 私有全局 MEMORY / SQLite 正文未同步在所读私仓；其中的 `.redcode/MEMORY.md` 是私仓项目模板。不能声称已经审完用户本机所有记忆。本轮确认的是可见规则与装配机制的冲突。
- 私有配置改动需要同步安装；只升级公共引擎不会修改本机 AGENTS 或旧插件。

## 模型可见四问

1. **内容**：上表列出原文与修改。记忆标签从 `Instructions from:` 改成 `Engineering memory from:`；来源头从统一覆盖声明改成工程指令、工程记忆与 Soul 各自的适用范围。记忆正文原样保留。
2. **Token**：以 `Token.estimateReporting` 估算，非真实 provider 计费 tokenizer：default 2065→2062（−3），GPT delta 431→382（−49），DeepSeek delta 153→157（+4），GLM 97→97，Conversation 630→429（−201）；私有 AGENTS 2243→2132（−111）。来源头 18→66（+48），每份记忆仅增加来源标签的少数字符。按常用路线和已同步私有规则，整体固定前缀净缩短，未把重复禁令转移到另一个层里。
3. **KV cache**：default 路线从其 reminder 条款变化处一次性重建；独立模型路线从 Instruction 来源头或 Conversation 的变化处重建。私有 AGENTS 更新从该来源起变化。工具表、Soul 和运行时装配顺序不变；同会话工具轮次的 system / tools 已逐字比较，没有新增模型调用或周期性人格重注入。
4. **硬上限**：Conversation 固定 1717 bytes；default / GPT / DeepSeek / GLM 均为固定源码文本。Instruction 仍受默认单源 1 MiB、总来源 64 KiB 上限约束，来源头为固定文本；Soul 的 16 KiB 和既有召回预算不变。default 与私有 AGENTS 仍超过 1K 估算 tokens，保留其实际工程和用户规则，不为压缩数字删除权限、验证与数据维护政策。

## 验证

- Instruction / prefix-shape / 路由：73 pass、1 个既有 todo；覆盖两份工程记忆共存、顺序、预算淘汰、来源清单与文本字节互证、诊断来源不泄露正文。
- 实际 SessionPrompt + 本地合成 provider：三份私有真人 Soul 原文及更新后的私有 AGENTS，各走 default / GPT / DeepSeek / GLM 四条路线，共 12 个会话、24 次 HTTP 请求。检查 Soul 正文完整、相处契约恰好一份、工程记忆标注、旧限制消失，以及 read 工具前后 system / tools 不变。私有文本未复制进公共仓库或发给外部模型。
- Chat / Code 分离夹具仍通过；legacy 与 native 的相处连续性摘要夹具各通过。私有 ECC 模块检查确认不再覆盖摘要，同时 shell 环境与 git 工具保留。
- 核心类型检查通过。上述验证证明送达内容与装配行为，不是对真实模型长任务人格稳定性的评分。

关联：[主会话相处契约](2026-11-17-soul-conversation-continuity.md)、[提示词职责](2026-09-24-prompt-instruction-ownership.md)、[Chat 工程记忆边界](../bug-fix/2026-11-17-chat-engineering-memory-boundary.md)。
