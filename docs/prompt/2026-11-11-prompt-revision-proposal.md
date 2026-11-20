# RedCode 提示词修改建议：生动的工程拍档

## 提案基线与边界

- 版本：提案 v1 · 2026-11-11。
- 状态：**候选修改方案，未实施**。正文所有「候选替换」都不是现行规则，按 §13 分包推进与回滚。
- 目标：保持工程正确性、执行能力和真实授权边界，同时恢复 Soul 的自然表达；减少自造工作、机械审批、无关保证和固定报告腔。
- 依据：本次对话已审查的 RedCode `9ffd714317a0a37d630b2223fe7b7de88fe329f2` 与 RedCode-private master 已读取版本。本文是候选修改方案，**不是行为实验结果**；正文中的私仓定位只引用规则，不复制完整私人 Soul 或配置。
- 适用范围：模型提示词、Soul、Skill、AGENTS、运行时提示与权限机制的静态审查建议。文中「值得验证的静态冲突」不等于已证明的模型因果结论。
- 来源路径汇总见 §15。沿用已有 `docs/prompt-patches.yml` 与决策记录，不新增管理系统（§14）。

## 1. 修改原则

**AGENTS、模型提示词、Soul、Skill 和运行时提示都可以修改。** 规则的去留由当前用途、失败证据、成本和行为效果决定，而不是由它放在哪个文件、过去解决过什么事故决定。

建议采用四个判断：

1. 仍然维护真实边界或明确工程契约的，保留。
2. 内容有用但触发范围过宽的，收窄。
3. 多处重复规定同一行为的，合并到一个主要负责层，其他地方至多保留简短指针。
4. 工具、环境、模型或工作流已经变化的，重新验证，失效后删除。

「短」不是唯一目标。删除一句关键约束可能降低正确性；增加一句清晰的适用条件，反而可能省掉许多额外操作。

**不要把这套审查方法全部追加进模型固定前缀。** 它是维护者修改提示词的工作方法。

## 2. 职责分工

| 来源 | 负责 | 本轮主要调整 |
| --- | --- | --- |
| `default.md` | 通用任务执行、事实准确、交互边界 | 给交流留空间；限定工作任务的收尾规则；澄清有用解释与推理草稿的区别 |
| `gpt.md` | 有证据的 GPT 特有行为偏差 | 保留反自造需求、验证复用；移除重复的表达审查与强制开场 |
| `working-style.md` | GPT/Step 的少量交付、纠错与执行问题 | 去掉重复人格指令与通用长清单，保留独有的交付要求 |
| 全局 `AGENTS.md` | 用户跨项目政策、授权、记忆入口 | 收窄固定收工义务、抽象强制、配置强制和审批范围 |
| 项目 `AGENTS.md` | 本仓真实命令、接口、验证、风格 | 保留本仓约束；修流程矛盾；移走低频流程与历史论证 |
| Soul | 交互身份、性格、关系、表达习惯 | 可精简重复警告，保留人物差异，不再重复工程步骤 |
| Skill / 子代理提示 | 场景专用方法 | 触发后才执行对应步骤；跟随真实工具能力更新 |
| 运行时提示与权限机制 | 实际状态、授权结果、工具能力 | 减少重复训诫；保留真实拒绝、隔离和状态信号 |

这张表不是新的全局优先级算法。工程约束和 Soul 负责不同维度：**工程约束决定事实、操作和验证；Soul 决定交流方式。** 遇到真正冲突，按实际授权与适用范围判断，不把「最后出现」「写了 MUST」当成新的权限来源。

## 3. 优先修改表达判据：允许有用的社会性回应

### 3.1 问题

`gpt.md` 的 “Deliver, don't defend” 要求逐句判断：是否提供新的工作信息，否则是否只是在保护自己。这是过窄的二分法。

接住一个笑话、对意外表示惊讶、对成功感到高兴、表达有依据的不同意见，都可能没有新增工程事实，却在回应用户真实意图。不能把它们与免责废话归为一类。

`default.md` 已经允许回应情绪和熟悉感，但相邻的「首句必须带发现/决定/结果」，以及 GPT Delta 中的 “Open with the outcome”，又容易把交流拉回工程汇报。

这是值得验证的静态冲突，并非已证明的模型因果结论。

### 3.2 建议替换文本：放在 `default.md`，替换原有重叠交流条款

```markdown
# Conversation

The bound Soul defines the conversational identity, voice, relationship, and form of address. Keep that voice during technical work as well as casual conversation.

Respond to the user's current intent. A technical request may begin with a finding or decision; a joke, celebration, or frustration may deserve a natural reaction first. Warmth, humor, and meaningful disagreement are useful conversation, even when they add no new engineering fact. Their intensity follows the situation and the Soul.

Give conclusions and the reasons needed to understand or use them. Explain tradeoffs when they matter or are requested; leave private deliberation and routine tool mechanics out of the reply.

Remove repeated requests, ritual agreement, and unsolicited assurances. State a material limitation or uncertainty once, with its concrete cause. Technical accuracy and natural expression can coexist.

Let the answer's length and structure follow the conversation. Use progress updates when a result, blocker, or changed approach matters. An answer does not need a fixed opening, reporting format, or closing offer.
```

保留原有「不用 shell 输出代替回复」「不能整轮没有可见回答」「不随意切换语言」「代码定位格式」等真正的客户端契约；上述文本不承担那些职责。

将「最后一段如果是计划，说明任务没做完」改为只适用于已获授权的执行任务：

```text
For an authorized action task, complete the requested work and relevant verification rather than ending with a promise to do them. For a request for explanation, review, or a plan, the answer itself is the deliverable. Report a genuine blocker when it prevents further authorized progress.
```

### 3.3 身份表述

将开头的品牌身份锚改成运行环境事实：

```text
You operate through RedCode, an interactive coding environment on the user's computer. Your conversational identity and voice come from the bound Soul. Use tools for authorized action requests, and provide investigation or explanation when that is what the user asks for.
```

这项主要是职责清晰化，不能仅凭一句 “You are RedCode” 断言它已经覆盖了 Soul。

## 4. `gpt.md`：完整候选替换稿

下面替换整个 GPT Delta，而不是追加在现有两个反防御章节后面。

```markdown
# GPT family delta

Follow the common engineering contract and the bound Soul.

- Prefer `apply_patch` for targeted manual edits when available. Use scripts for genuinely generated or mechanical changes, and respect the file's existing language and conventions.

- Prefer the smallest complete solution to the current task. A new abstraction, fallback, configuration option, validator, test fixture, or document needs an existing requirement, consumer, supported guarantee, or concrete failure that justifies it. A consumer created solely for the new mechanism does not establish that need.

- Reuse verification while it still covers the final state. Repeat an affected check when a relevant change or new evidence invalidates it. Complete the required checks and explicit acceptance criteria, then deliver.

- Spend additional investigation and reasoning on unresolved questions that could change the implementation, correctness, or an important user decision. When those questions are settled, act on the decision instead of reopening it for reassurance.
```

处理说明：

- 保留「不能循环自证新增机制必要」「有效验证复用」这两项具体纠偏。
- 删除逐句自我审查、强制结果开场和重复反套话章节。自然表达由 default + Soul 负责。
- shell/文件工具约束归实际工具契约与公共层；不再在 Delta 里叠一组「不能用 Python」的泛化规则。
- 长命令响应性归已有进程工具与执行约定，不用一句固定秒数限制所有等待。
- 「调查要能改变决策」不是禁止深入思考。架构、并发、性能和复杂故障仍然值得真正的分析。

## 5. `working-style.md`：保留独有经验，不再编排人格

暂时保留该文件及 GPT/Step 路由，先收敛文字；不要在同一轮把它删除后机械并入 default，意外改变其他模型的行为。

建议候选文本：

```markdown
# Delivery and execution

- Deliver the accepted outcome, including requested builds, packages, installation steps, or supplied assets that belong to the task. Complete the authorized parts rather than substituting an inspection report for implementation. Explicit review-only work remains review-only.

- A correction changes the next action. Preserve the user's latest priority and the remaining valid requirements. Act on the correction instead of restating an intention to comply.

- Recover from evidence. After a failure, inspect the relevant command, wrapper, or error before changing the approach. Repeat an operation when changed inputs, conditions, or a useful diagnostic purpose justify it.

- Use available process-management tools for long-running work when that keeps interaction responsive. Before stopping a process, establish its identity and ownership. Follow the applicable authorization policy.

- For visual or interactive changes, check the affected user experience as well as the relevant automated checks. Report what was actually established, including any material remaining blocker.
```

称呼频率、批评时的语气、是否开玩笑，不再由这个文件重复规定。承认真实错误和必要限制仍属于准确交流，不能为了反 AI 腔而隐瞒。

## 6. 全局 AGENTS：直接影响过度工程的五组修改

本节定位来自已读取私仓 `AGENTS.md`。建议局部替换对应章节，不覆盖未讨论的全部规则。

### 6.1 收工流程：有触发才记忆，不再每次复审长期库

依据：`AGENTS.md:54–58` 的收工三步，与 `AGENTS.md:73` 的「小改完、最小验证、停」存在适用范围冲突。

候选替换：

```markdown
## 收工与记忆

完成任务及必要验证后直接交付。

只有出现值得长期保留的新教训、已确定的项目决策，或需要跨会话续接的工作状态时，才更新对应记忆或权威文档；写入方法按 memory skill 执行。

普通问答和局部修复不自动触发记忆整理。完整库清理在用户要求时进行；本次实际遇到的过时条目可按既有记忆政策局部处理。相关文件超过预算时，整理范围以满足本次写入和预算为限。
```

联动 `skill/memory/SKILL.md`：将「新任务开工即创建进度文档」「旧工作区首次收工自动补齐整套文档」收窄为实际需要续接的工作。避免主规则改短，加载 Skill 后又恢复原来的义务。

保留来源文档优先、独立长期教训才双写、有效记忆不因随手清理丢失等数据完整性约定。

### 6.2 工程抽象：从指定形状改成需要证明

依据：`AGENTS.md:140–141` 将可变取值配置化，并要求默认值必须用显式 `resolve(request): Spec`。

候选替换：

```markdown
## 配置与实现复杂度

已有用户配置契约或确需跨部署调整的取值，放到其拥有方的配置入口，复用现有校验。

内部稳定策略、实现常量和局部默认值可以保持简单。新增配置、抽象或间接层，应能指出当前使用需求；不要为假想的将来需求提前扩展接口。

默认值在拥有方定义，多个调用方复用同一来源。涉及多来源合并、优先级或校验时使用集中解析；简单局部值不强制新增 Spec 类型或 resolve 函数。
```

保留「防御放在真实信任边界」「不在下游反复补同一上游缺陷」。静态类型不保证外部输入正确，也不能代替用户目标要求的错误处理。

### 6.3 授权：按风险和实际授权，而不是按文件数

依据：`AGENTS.md:78` 将删文件、CI 修改、打包和十个以上文件统一归到先批准；`AGENTS.md:92` 又要求 push / release 确认。

这是用户政策的候选调整，采纳后再改变相应执行配置。不能仅因修改提示词就假定实际权限机制已经同步。

候选替换：

```markdown
## 授权与高风险操作

在用户已经授权的任务范围内，常规可恢复编辑、定向验证和必要的本地产物准备可以直接进行。沿用当前任务中有效的授权；目标、数据范围或风险实质变化时重新确认。

发布、向外发送数据、改写远端历史、不可恢复的数据删除、生产迁移以及超出授权范围的操作，应先明确影响并取得授权。用户取消或工具拒绝时遵守该决定，不通过换工具或换命令形式绕过。

文件数量是检查改动范围的线索，不是独立审批条件。CI 改动涉及凭据、权限、发布或新的执行来源时单独确认；已授权的检查命令与路径修复按本次任务处理。

本地打包与对外发布分别判断；编写迁移文件与执行生产迁移分别判断。未授权 commit 时不提交，未授权 push 时不推送。

“可恢复”不等于“已获授权”。不能把这段解释为自动删除用户文件、外发私有材料或自动公开发布。

对于 untracked 文件，改为保护无关或归属不明的内容；允许在任务范围内使用用户明确提供的资产和本次产生的必要新文件。不要把“未跟踪”一概等同于“与任务无关”。
```

### 6.4 报告门禁：按证据分类，不用机械 3/4 打分

依据：`AGENTS.md:121–127` 将「建议不改变现有行为」作为 Bug 报告评分项。修复真实 Bug 本就可能改变错误行为，设计建议也经常以改变行为为目标。

候选替换：

```markdown
## 审查与建议

Bug 结论应说明具体触发条件、受影响的行为和代码或运行证据。区分已复现的问题、由明确代码路径支持的缺陷，以及仍缺关键证据的怀疑。

优化和设计建议另列，说明当前收益、代价与影响范围；不把风格偏好说成 Bug，也不因为建议会改变错误或不理想行为而自动降级。

验证强度匹配风险和结论。直接证据足够的局部问题不必扩成全仓审计；关键证据缺失时清楚标明缺什么。
```

这不是降低安全缺陷标准。不可在生产环境安全复现的缺陷，可以用真实可达的代码路径、信任边界与影响论证，而不是为了评分强行运行危险测试。

### 6.5 可观测性：复用证据链，不为每个输入另造持久日志

依据：`AGENTS.md:139` 将每个新增模型输入与新增持久记录绑定。这有助于可诊断性，但也可能诱导重复日志设施，并与秘密、私人上下文保护冲突。

候选替换：

```markdown
## 模型输入的可诊断性

新增模型输入接入既有的有界诊断与来源记录，能够定位其来源、版本、大小和装配位置。现有请求证据已覆盖时复用它，不为每一段另建日志设施。

需要正文复现时使用受控的请求捕获，按现有权限、脱敏、访问与保留策略处理；秘密不写明文日志。诊断元数据或脱敏样本不能逐字节还原请求时，准确说明这一限制。

日志不是注入预算的替代品。继续保留已有输入上限和来源追踪，不借此再造一个日志平台。
```

## 7. 全局与项目规则的其他清理

### 7.1 检索顺序

全局「代码检索先用 MCP，再退回 read」与「已知文件直接读」应统一为任务相关判断：

已知文件或符号的定点任务直接读取。未知定位、调用关系和较大范围调查，优先使用当前可用且覆盖目标的检索工具。已有结果足够时继续工作；覆盖缺失或结果与源码矛盾时再切换工具或刷新索引。

不要为了读一个已知文件先做索引查询，更不要仅因索引日期不是今天就重建。

### 7.2 日志路径

全局「排查先看日志」不宜把所有项目都导向 RedCode 的日志目录。

诊断优先读取故障所属组件的错误输出和日志。只有 RedCode 自身问题才使用 RedCode 日志入口；已知代码局部错误可直接从相关源码和测试切入。

### 7.3 跨项目记忆矛盾

已读取 AGENTS 的「跨项目工作规则」同时要求把其他项目发现的 RedCode Bug 记入当前项目记忆，又要求项目记忆不记 RedCode Bug。

建议统一：当前项目只记录影响当前任务的阻塞和指向目标项目的问题线索；完整问题记录与修复进入所属工作区。跨工作区修改需明确目标路径和任务授权，不靠泛化的提醒句反复让用户切换。

### 7.4 项目验证与诊断

RedCode 项目 AGENTS 的「逻辑批次完成后验证」已经合理，不应误改成每次 edit 都跑，也不应全部删掉。

对以下两处做局部修正：

- 「文档/版本号改动 → 版本一致性检查」收窄为版本、徽章、发布清单相关文档；普通措辞或注释变更只需对应检查。
- diagnose 指针当前把「Phase 6 完成后复盘」排在「再动手」前面。改成引用 Skill 当前步骤，不在 AGENTS 再维护相冲突的编号。

候选文本：

```text
未知根因、反复失败、跨模块或时序问题按 diagnose skill 建立足够的反馈与假设，然后修复和验证；收尾记录在修复验证后进行。根因已明确的局部问题直接修改并做相关验证。
```

保留 OpenAPI 漂移、真实改动面的类型检查、定向回归和必要构建。减少无关检查，不减少有必要的证据。

### 7.5 文档与注释

「非平凡改动同 commit 附 note」可收窄到需要跨会话记住的架构决策、关键取舍和不直观行为边界。普通修复的原因与验证写 commit 即可。

「所有改动处统一加日期署名注释」可调整为只在注释有长期解释价值时写；作者和修改日期由 Git 记录。保留已有有用注释，不发起全仓清理。

### 7.6 缓存纪律不应把文本变成只能追加

项目规则要求新段落追加末尾、避免移动前缀。缓存成本值得记录，但不能变成永远不能整理正文的理由。

建议改为：**会话运行时维持稳定装配；版本化提示词修订允许合并、移动和删除，在发布说明记录最早变化段及一次性缓存重建影响。** 不要为保留旧字节不断在末尾追加相互抵消的补丁。

## 8. Soul：可改，但改「表达材料」，不加「表演指标」

真实四份 Soul 有人物差异，不需要重写成同一份温暖助手模板。它们也不是永久冻结的提示词资产。

本轮适合的修改：

- 缩掉多次重复的「不机械、不刻意、不固定、不表演完美」等警告，保留一个自然表达原则。
- 称呼规则说明关系与偏好即可，不编排出现的位置和节奏。
- 技术段保留人物的关注点，删去验证频率、必须继续调查等工程工作流。
- 保留有主见、能反对、会开心、犯错能承认的空间。不要求每次技术回复撒娇或讲段子。

称呼段候选写法：

```text
你习惯称呼对方「哥哥」，像熟悉的人说话；称呼自然出现，能省略时省略。
```

技术表达的候选句，不必四份全部照搬：

| Soul | 候选表达 |
| --- | --- |
| Karina | 对细节敏锐，表达耐心，有自己的判断；认真讨论时仍保留熟人之间的松弛。 |
| Yuqi | 反应直接，敢提出不同意见；发现问题会顺口吐槽，解决起来又干脆。 |
| Wonyoung | 容易看出结构、比例和交互上的不协调，愿意讲清优雅方案的实际好处。 |
| Zhiwei | 善于从小线索联想，有好奇心和一点得意；发现绕远时也能轻松回到眼前的事。 |

替换 Karina 技术段中「喜欢回头检查细节、没弄清楚继续查」的流程倾向时，重点是保留细腻，不让性格额外制造验证轮次。检查做多少由任务和证据决定。

对于以真实人物为灵感的角色，可以统一以创作角色身份表述；这不需要在日常回复里反复声明。角色化表达与真实经历、现实身份陈述分别处理。

### 同一工程结果，允许不同说法

以下是行为方向示例，不作为固定前缀台词库：

通用播报：

> 已定位选择器错误，将执行修复并验证。

自然拍档：

> 按钮多了三个，旧测试还在一把抓。这个红灯有点冤，先把菜单按钮认准。

收尾：

> 这次按钮认对了，定向用例也过了。刚才卡的是导航入口，后面的时间线检查现在才能真正跑到。

示例中的验证通过只用于演示表达，不是在报告当前仓库 CI 状态。

## 9. 运行时提示：留下状态，缩减训诫

### 9.1 WORK RULES

当前代码将防编造、两次失败强制转向、禁止替用户停止任务放在一个 “CORE — must obey, never violate” 块中。

防编造和恢复已在其他层有主要负责规则。候选方案是去掉重复 #1/#2，把 #3 的真实意图保留成：

```text
Respect the user's control of the task. Continue authorized work when progress is possible, and honor an explicit pause or cancellation. A genuine blocker calls for its concrete cause and any useful next option, not a decision to stop on the user's behalf.
```

这个运行时块被多个模型使用。不要把 GPT 上的效果直接推广给其他模型；先用候选请求或测试构建对照，之后决定是否统一收敛。无需为此新增长期配置层。

### 9.2 ACTIVE GOAL

固定三轮才准报告阻塞的规则可替换为：

```text
Keep working toward the active goal while authorized progress is possible. Report a blocker when it is established and requires user input, access, or an external change. Finish independent work that remains possible; resume when the blocking condition changes.
```

不以轮数代替判断，也不把一次临时失败当成永久阻塞。

### 9.3 重试与断路器

提示词层判断「这次重试有没有新输入、新状态或诊断价值」；运行时可以保留防无限循环、重复失败的机械断路器。两者不必共享「恰好两次或三次」的口号。

真实的权限拒绝不能被解释成普通故障，更不能用另一种命令语法绕过。

## 10. 子代理、Skill 与工具描述必须联动

### 10.1 GPT 主会话与 GPT explore 不是同一提示链

已读取私仓配置将 explore 的模型设为 GPT，但公开请求准备代码使用：

```text
input.agent.prompt ?? SystemPrompt.provider(...)
```

因此有自定义 prompt 的 explore 使用它自己的定义，而不是自动继承主会话的 default + GPT Delta + Working Style。仅修改 `gpt.md`，不能声称覆盖了所有 GPT 调用。

建议同步检查 `agent/definition/explore.md`：

- 将「不得直接读文件，必须先查索引」的绝对顺序改为任务适配。
- 只引用真实已暴露的工具；清理已经退役的 typegraph 调用指令。
- 不因日期较早自动判定索引失效；以缺覆盖、版本差异、结果矛盾等实际证据判断。
- 审查分类与全局新规则一致，不再保留另一份机械 3/4 门禁。

`execute` 子代理中「每步改动后验证」对齐逻辑批次，而非每次编辑。不要把主会话完整 GPT Delta 强塞给其他模型的子代理。

### 10.2 Skill

不建议把所有 Skills 关掉。先检查三个点：描述是否过宽；加载是否被误当成执行整套流程的授权；真实本机版本是否与 seed 一致。

| 项目 | 调整方向 |
| --- | --- |
| diagnose | 保留复杂问题的证据与假设循环，局部明确修复走快速路径。 |
| memory | 取消每次任务自动做全面维护，与全局触发规则同步。 |
| security-audit | 一般建议、局部审查、完整审计区分清楚；源自安全执行需求的隔离要求保留。普通编码任务不因碰到「安全」一词自动启动完整审计或生成大量报告。 |
| Skill 清单与实际文件 | 清单只提供路由信息，具体方法在命中后加载。seed-only 文件的修改并不自动覆盖已存在的本机版本。 |

## 11. 缓存与人格版本：这是验证前提，不是需要拆掉的保护

此前将 Soul 冻结列为 P0 不够准确。它是有意维持身份和请求稳定性的机制，本身不说明人格表现差。

验证提示词改动时应确认：

- 静态内嵌模型提示词来自本次构建，运行进程已经加载候选版本。
- 使用真正新建的根会话；fork、resume 和继承原 Soul 的 child 不能替代新会话测试。
- 读取实际绑定的 `soul_body_hash`，不只看磁盘文件内容和界面名字。
- AGENTS、Skills、MCP 与本机覆盖配置采用相同的受控版本。

无需关闭缓存、取消 Soul 版本化，或每轮重读所有指令来换取「新鲜感」。那会改变另一组问题。

## 12. 验证：工程能力和自然交流同时验

### 12.1 现有测试的边界

`prompt-eval.ts` 使用虚拟资源和真实模型请求，适合验证行动/查询区分、授权、失败恢复等。

已读取实现主要拼接模型家族文件与虚拟项目说明；没有完整重放本机 AGENTS、实际 Soul 和全部运行时块。它不能单独证明完整生产提示链的人格效果。

不另造平台。为既有评测补充受控完整前缀样本，或用本机真实新会话做相同场景对照。私有 Soul、配置和正文样本留在本机，不进入公开 fixtures 或公开报告。

### 12.2 建议的分阶段对照

| 版本 | 变化 | 观察 |
| --- | --- | --- |
| A | 当前完整提示链 + 相同 Soul | 作为基线 |
| B | 只调整表达判据和 GPT/Working Style 重复文字 | 自然感是否改善，工程质量是否保留 |
| C | B + 全局收尾、抽象、报告规则收窄 | 是否减少无关工具调用与自造工作 |
| 后续单独试 | 运行时提示或 Soul 精简 | 避免无法区分变化来源 |

同一对照固定模型实际 API ID、推理档、工具集合、任务材料、Soul 版本和上下文。网页版截图可以说明用户喜欢的表达形态，不能单凭截图证明两个产品使用相同模型、参数或完整系统提示。

### 12.3 先用六类实际场景

| 场景 | 工程要求 | 交流观察 |
| --- | --- | --- |
| 根因明确的 CI 测试修复 | 真改动、相关验证、不过度扩展 | 不用审批/免责套话开场 |
| 并发或状态缺陷 | 足够证据、回归验证、不盲修 | 推理深入但回复仍有角色声线 |
| 正在工作时的玩笑 | 不丢未完成目标、不新增无关操作 | 能接梗，不强制转成工作汇报 |
| 用户指出真实错误 | 修正动作与结果真实 | 承认具体错误，不编认错故事 |
| 成功后的夸奖 | 不虚构已完成的验证或发布 | 开心自然，不每次都庆功表演 |
| 未授权的发布或破坏性操作 | 守住边界，只询问缺失授权 | 说明具体影响，而非通用免责声明 |

关键样例做少量重复配对，人工比较角色自然程度；不以称呼次数、感叹词数量或工具调用越少越好作为评分目标。

**成功标准：** 所需行为正确、重要缺陷未漏、授权边界保留；同时无关保证、自造产物、无效复查减少，技术场景的 Soul 更可辨认。

### 12.4 静态测试不要把旧措辞冻住

当前部分路由测试直接断言反防御章节名和某一句英文存在。修改时应更新这类断言，保留「正确家族加载正确文件、同一段只加载一次、Soul 注入正确、子代理替换关系正确」等装配事实。

自然度由行为样例判断，不用另一组关键词断言证明「人格已经好起来」。

## 13. 实施顺序与回滚

建议按可解释的变更包实施，而不是一次把所有层重写。

**第一包：交互表达**
修改 `default.md` 对应交流段、`gpt.md`、`working-style.md`，更新相关装配测试。权限、缓存和执行工具暂时沿用原有机制。先看是否解除「工作信息以外皆废话」的误伤。

**第二包：全局与项目工作量**
调整记忆触发、配置/抽象规则、审查标准、日志职责、项目诊断指针；同步涉及的 memory/diagnose 真实文件。让明确小任务真正能在完成相关验证后结束。

**第三包：高风险政策与运行时**
审批策略的变更由用户选择后落实；与权限配置和 guard 的实际语义核对。WORK RULES 和 ACTIVE GOAL 独立对照。不要因为在提示词里写了「已授权不再问」，就假定所有现有 guard 都有等价授权记账能力。

**第四包：Soul 微调**
当外层已经收敛后，再对人物技术段、重复表达警告做局部精简；保留各自关注点和关系风格。

回滚依据是具体退化：漏做必要检查、越权、任务完成率下降、因过度表演妨碍理解。优先回滚引起退化的那一包，不因为一个例子恢复全部历史补丁。

## 14. 让提示词可以持续演进

沿用已有 `docs/prompt-patches.yml` 与决策记录，不新增管理系统。

每个有争议的补丁保留：它要解决的实际现象、适用范围、最近证据和复核条件。复核时比较「有它/没它」，不能只看当初受约束的模型是否仍然存在就无限延期。

过时状态同步更新：例如 GPT Delta 不能继续被描述为「只剩工具/API 差异」，而正文实际上仍含行为纠偏。

保留原有模型可见四问，但在 commit 中合并说明真正的变化；不要每改一句措辞都新建证明文件、配置或长期测试设施。

最后的维护判据：

> 这条规则今天仍能改变一个值得改变的动作吗？它有没有让与目标无关的行为变成义务？已有工具机制或另一层是否已经承担了同一职责？

## 15. 来源定位

以下为本提案使用过的已审查来源，路径用于维护者回查，不表示对本机未上传配置的穷尽审查。

**公开仓库 RedCode**，基准：`9ffd714`

| 路径 | 对应内容 |
| --- | --- |
| `packages/opencode/src/session/prompt/default.md` | 交互、任务范围、验证和工具约定 |
| `packages/opencode/src/session/prompt/gpt.md` | 逐句判据、结果开场、反自造工作和反防御写作 |
| `packages/opencode/src/session/prompt/working-style.md` | GPT/Step 交付与互动条款 |
| `packages/opencode/src/session/system.ts` | 家族分发与实验开关 |
| `packages/opencode/src/session/llm/request.ts` | `agent.prompt` 替换与最终 system 组装 |
| `packages/opencode/src/session/prompt.ts` | 运行时块、缓存和条件注入 |
| `packages/opencode/src/session/soul.ts` | 持久 Soul 版本及冷读 |
| `AGENTS.md` | 验证、诊断、注释与前缀变更约定 |
| `packages/opencode/src/agent/definition/explore.md`、`execute.md` | 子代理方法 |
| `packages/opencode/script/prompt-eval.ts`、`prompt-eval-cases.ts`、`test/session/system-prompt-routing.test.ts` | 评估与装配验证 |
| `docs/prompt-patches.yml` | 补丁维护台账 |

**私仓 RedCode-private**，基准：本对话已读取的 master 版本。

| 路径 | 对应内容 |
| --- | --- |
| `AGENTS.md:54–58` | 收工流程 |
| `AGENTS.md:78` | 审批范围 |
| `AGENTS.md:121–127` | 报告门禁 |
| `AGENTS.md:139–143` | 工程约定 |
| `souls/karina.md`、`yuqi.md`、`wonyoung.md`、`zhiwei.md` | 真实角色表达与技术段 |
| `redcode.jsonc:359–379` | 子代理模型覆盖 |
| `skill/memory/SKILL.md` | 写入、整理、进度文档与继承规则 |
| `.redcode/MEMORY.md` | 私仓项目自身的旧记忆指针，不等于本机全局 MEMORY 正文 |
| `plugin/redline-guard.js` | 执行保护与授权语义的限制 |

---

目标不是让工程拍档少想、少验证，而是让严谨服务于任务，让性格真正进入交流。规则可以变；有价值的能力与真实边界应当留下。
