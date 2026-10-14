# RedCode Skill 体系瘦身与职责边界审计

> **日期**：2026-10-13
> **性质**：第三方只读审计 / 交接给 RedCode 的实施建议；**不是自动改仓指令**。
> **审计基线**：`JiaHuiRed/RedCode-private` `master` @ `a178217365e14547da0b939d5df838d2a2dc3fa3`；`JiaHuiRed/RedCode` `dev` @ `054cf0275da3067db90fd694fb1539d52a56db06`。
> **范围**：私仓 `skill/*/SKILL.md` 共 23 份、部分 `references`，全局 `AGENTS.md`、Memory、Soul 与公仓 Skill 发现/加载/播种机制。私仓本地未推送文件、运行时真实调用频率未纳入。

---

## 0. 决策摘要：不是「删掉一半 Skill」

23 份主 `SKILL.md` 共约 **211,635 UTF-8 bytes（206.7 KiB）**，附属 references 不计在内。**它们不是 206.7 KiB 固定前缀**：引擎通常只在可用 Skill 清单暴露名称/描述，调用 `skill` 工具才把对应主 `SKILL.md` 全文作为工具结果注入会话。具体可核对公仓 `packages/opencode/src/skill/index.ts`、`packages/opencode/src/tool/skill.ts` 和 `packages/opencode/src/tool/skill.md`。

本轮应优化的成本依次为：

1. **误触发成本**：只是普通修 bug，却被一个含糊的 Skill 描述引入六阶段治理。
2. **加载后行为成本**：Skill 正文默认展开多代理、全仓扫描、过多检查、自动提交。
3. **角色和权限边界**：专业技能不能宣称自己是某个 Soul；建议不能无意间扩大破坏性操作授权。
4. **知识漂移**：技能里写死仓库路径、模型能力、旧命令、旧状态或与 AGENTS 的相互矛盾。
5. **Token 体积**：只有调用频率高且正文长期过大时才值得主动拆分；单纯 KB 大不是问题。

**建议保留 23 个 Skill 的名称和发现路径，不增加路由框架，不新增强制治理工具。** 优先清理最有害的触发与流程。任何变更先以最新本地版本为准，避免覆盖未推送工作。

## 1. 已经修好的问题，禁止重复返工

基线已包含今日新提交：

- 私仓 [`c499c293`](https://github.com/JiaHuiRed/RedCode-private/commit/c499c293c5328e9fbe9d8cfa1dbcb3a09facc7bc)：`AGENTS.md` 的记忆五问全文迁往 `skill/memory/SKILL.md`；跨机编号改用本机 DB + origin 快照；字符数/字节数混用已说明；DCP 旧节已删除；旧 todo 冗余句已删除。
- 公仓 [`bc9be4b2`](https://github.com/JiaHuiRed/RedCode/commit/bc9be4b22396fcc9a0266df79959b10ee2eb2834)：同步 `seed/skill/memory/SKILL.md` 与现行 live 口径。
- 私仓 [`a1782173`](https://github.com/JiaHuiRed/RedCode-private/commit/a178217365e14547da0b939d5df838d2a2dc3fa3)：四个 Soul 减少无关章节，保留「我是谁 / 我和哥哥 / 我怎么说话」，并解释「哥哥」的中文亲昵称谓语义。**不要再为了 Skill 审计重写 Soul**。
- 公仓 [`27ce0506`](https://github.com/JiaHuiRed/RedCode/commit/27ce05061dc20f64e0daf5704eca4499d99da093)：删除 minimax/ollama 旧特有提示词与 kimi DCP 残留；本轮不要把它们视为待修。

本审计不重复原有过时结论。若私仓 `master` 在执行前又更新，务必重新核对 SHA。

## 2. 优先级 P1：建议先改、改动小而收益明显

### P1-A `ce-code-review`：深审应是显式选择，不是普通审查的入口税

**现象**：`skill/ce-code-review/SKILL.md` 约 12 KB、324 行；六个 always-on 审查视角，顺序执行 6 阶段 pipeline。frontmatter 的「review 一下 / 审一下代码」触发范围比正文的「深度审查」更宽。文档第 96–101 行将交互模式写成默认可应用安全修复，虽第 173–177 行要求实际应用前征询用户，但仍易将“只看一下”误解为“审并修”。

**建议**：

- frontmatter 明确：**用户要求深度审查、PR 发布前完整审计、明确安全高风险审查**才加载；普通“看看这个 diff”优先当前模型直接轻审。
- 默认模式为**只读报告**；用户另行明确授权才进入修改/提交，不应因为审查 Skill 被加载就自动获得修复权限。
- 保留 severity、证据锚定、去重和风险分级；不要把「六位评审」当成每次强制执行的子代理数量。先用当前模型读 diff，确有独立视角价值时才派子代理。
- `mode:agent` 也允许根据请求风险走轻审，别强制完整 pipeline；保持已有结构化输出消费者的兼容性。
- “两位审查者同时提到就升级优先级”仅作为复核线索，**不能替代可复现证据**。

**验收**：一个 1 文件的普通 review 只读、有证据、可输出零发现，不开启多审查者流水线；一个涉及 auth/migration 的 PR 仍能运行深审并保持现有 report schema。未经允许零文件修改、零 commit。

### P1-B `tdd-flow`：把“认真做”与“启动全套流程”解绑

**现象**：`skill/tdd-flow/SKILL.md` 描述把“认真做、严格点”与 TDD、worktree、子代理、`ce-code-review` 一整套绑定；正文虽承认小改应跳步骤，但核心建议仍是完整六阶段。与全局 `AGENTS.md`、默认提示词的最小验证、todo 指引重复。

**建议**：

- frontmatter 以**明确要求 TDD**、高回归风险或确实复杂的跨模块功能为主；“认真点”只加强证据要求，不强制开启六步流水线。
- 删除强制“由另一位审查者复审”与硬性 worktree/子代理编排；仅在代码所有权、并行度、跨模块风险要求时启用。
- 保留核心 TDD 思想：高风险逻辑先观察测试失败，确认断言能真正覆盖回归，再实施修复。
- 验证由改动范围决定；不要在 skill 内重复仓库级测试命令与授权禁令，引用项目 AGENTS/工具契约即可。

**验收**：修改 RedMon 一个 Move 数据数值不会开 worktree/派 review 子代理；修改核心伤害计算与升级路径时仍能做到可复现、定向回归与需要时的深审。

### P1-C `fewer-permission-prompts`：收窄危险命令示例

**现象**：该 Skill 第 94–105 行提供的示例含 `git checkout *`、`git stash *`、`git pull *` 等宽泛全局 allow；第 117 行又声称“哥哥的工作规矩是可以自由 commit、push 才要授权”，与当前私仓全局 AGENTS 的 **commit 与 push 均须明确授权**冲突。

**建议**：

- 示例只采用**不造成损失的精确命令**；不提供 `git checkout *` / `git stash *` / `git pull *` 的全局 allow 推荐。
- 保留统计弹窗来源、`destructive` 与 `bash` 键区分、`findLast` 顺序和 wildcard 语义；这些是有真实工具契约价值的内容。
- 统一以**当前用户最新授权和全局 AGENTS**为准，移除所有“可以自由 commit”的过时陈述。
- 验证许可建议采用安全的分类测试/假请求，不为了测试弹窗而真实执行可能改写工作树的危险操作。

**验收**：普通读操作不增加弹窗；`git push`、危险 checkout、文件删除仍需要正确授权。用户明确请求减少弹窗时才加载。

### P1-D 文风 Skill 的 Soul 污染

**现象**：`skill/red-scribe/SKILL.md` 和 `skill/yuqi-slop/SKILL.md` 正文开头自称“我是雨琦”。这两份 Skill 可能在敏敏、元英、知微的会话中加载，虽然是写作技巧，却能误导当前模型身份。

**建议**：

- 改为中立描述：“本技能提供××写作风格/编辑方法，不改变当前会话 Soul、身份、称呼。”
- `red-scribe` 聚焦用户个人技术写作风格；`yuqi-slop` 聚焦**中文**自然化；`stop-slop` 聚焦**英文**去 AI 味。分别触发、需要时可组合，禁止随便全叠。
- `stop-slop` 的 `metadata.trigger` 含未限定语言的“去 AI 味”，和 frontmatter 的英文限定不一致；收紧描述，避免中文误加载。
- 不把写作参考示例变成固定回复模板；文风不是 Soul 的替代品。

**验收**：四个 Soul 分别加载这两个中文 Skill 后身份/称呼不变；中文自然化不会默认调用英文 Skill；技术文档可按用户要求独立采用用户文风。

## 3. 优先级 P2：在 P1 稳定后再动

### P2-A `technical-documentation`：避免“写一页文档 → 全仓扫文档”

目前 frontmatter 同时覆盖一份 README、AGENTS 审计和全仓治理；第 28–38 行倾向先盘点全仓，第 59 行将 `apply-fixes` 设为默认，在用户只说“审查”时存在越界风险。

- 区分**单文件写作/编辑**、**指定目录审查**、**全仓治理审计**三档；仅第三档遍历整个文档树。
- 用户说“审一下”默认只读，不自动编辑；“写/改”在既有授权范围内直接产出，不为普通文档任务追加治理报告。
- `references/` 只读取与当前任务相关的篇章；不要单份 README 任务默认加载全部 reference。
- 删掉对所有文档任务要求 sub-agent 的措辞，保留“真正跨框架/范围巨大时可并行”。

### P2-B `apple-design` 与 `frontend-design`：缩窄设计 QA 的机械门禁

`apple-design` 约 35 KB、541 行，有价值的动效物理细节很多；`frontend-design` 约 15 KB，末尾含静态 grep 与“新增设计约束就必须挂检查”类指导。

- **不要删掉真正专业的交互知识**；若数据表明加载频繁且上下文开销显著，再把大块公式、清单移到按需 `references`。
- 普通按钮 hover / 8px 间距修改只需相关文件和视觉确认；用户要求整体动效或可访问性审计时，再加载完整设计规范。
- `frontend-design` “新增设计偏好一律配 lint/CI gate”改为风险分级：视觉品味偏好不应强制写机器门禁，只有可自动检查且严重影响可访问性/一致性的规则才值得机器化。
- 对字体、色彩、尺寸的硬编码禁令要服从既有设计系统、项目风格、用户参考，不应把通用 taste 变成全局 lint 错误。

### P2-C `memory`：保持最新单一权威，处理数据冗余

`c499c293` 已把五问、编号、字符/字节冲突收敛到 memory Skill；**不要重做**。剩余事项：

- 审核 Skill frontmatter 是否准确触发“写入长期记忆”，不应每个普通修复结尾自动加载整套 219 行整理流程。
- 区分“记录一个高价值教训”和“运行一次全库剪枝”，后者只在阈值/用户要求下执行。
- 核对今日 `memory/lessons-backup.Lin.md` 中看起来同义的 `#658/#662`（Bun mock.module）与 `#659/#663`（长回合新用户指令）。这可能是不同记录格式的备份冗余，**先按 DB id / 全文 / 创建时间确认，再决定是否合并**，不要直接删任何正式记录或改历史 ID。
- 复审 `MEMORY.md` 索引是否含该机器专有/短期内容；索引可以剪，DB 内容先核备份。

### P2-D `config-edit`：触发描述不要比执行规则绝对

frontmatter “live 与 seed 必须同改”过于绝对；正文已说明 `redcode.local.jsonc`、同步主配置与 `seed/redcode.home.jsonc` 的不同语义。建议改为“按配置归属区分修改位置，需同步的再同步”，避免仅改本机 provider 时无端触碰公仓 seed。保留三层验证，但项目只改一处局部值时采用与风险匹配的最小验证。

### P2-E `species-design`：尊重 RedMon 最新项目事实

当前写死 `F:\\Pokemon\\RedMon\\data\\species.json`、10 月 11 日精灵数量示例和单视角 512×512 生图说明。这些可能仍符合本机，但属于**项目状态而不是普遍 Skill 规律**。

- 路径从实际项目工作区定位，而不是永远假定 `F:`；数量始终实时读取。
- 生图尺寸、透明背景、立绘/精灵图规格先对账 RedMon 最新 `docs` 与现行素材规范；不要把旧规格直接当永久真理。
- 将长期稳定的种族值/进化链设计规律与易变的项目 JSON 字段结构分开；后者优先引用仓库真实 schema/示例。
- 若该 Skill 主要服务 RedMon，可保留为私仓全局 Skill，但仅在 RedMon/明确的精灵设计任务触发；不要在其它项目泛化。

### P2-F `vision-autoagent`：防止读错图

在无法直接读用户图片时，Skill 按文件最近十分钟/mtime 选“最新图片”进行分析，这在用户多个素材、并行会话情况下不可靠。应优先使用会话提供的确定附件 ID/路径；没有可靠关联就明确说明并询问，而非猜最近文件。不得在用户不知情时把无关目录新图片当成本次附件。

## 4. P3：轻改或暂缓

| Skill                      | 判断                                                   | 处理                                                                |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `bump-version`             | 已从 RedCode 专用清单转为通用骨架                      | 仅核对提交/tag 授权与项目真实策略，不用重写                         |
| `diagnose`                 | 已有清晰的高风险触发与小改跳过条件                     | 保留，观察实际误触发率                                              |
| `effect`                   | 篇幅短、领域技术性强                                   | 保留                                                                |
| `simplify`                 | 目标清晰，约 61 行                                     | 精简完成清单中的重复全量 typecheck/人工调用链义务；保持按影响面验证 |
| `run-redcode`              | 实际环境与自举调试知识有价值                           | 保留，检查旧目录、命令与最新版引擎是否漂移                          |
| `officecli`                | 工具规格较大但按需使用                                 | 不因 26 KB 强删；必要时调用 `help` 或子技能                         |
| `new-project`              | 默认路径、MIT、固定 README、初始文件可能过度替用户作主 | 语言/许可/目录由用户偏好或项目要求确定，不必先生成不需要的文件      |
| `goal-automation`          | 只建议不强制，约 43 行                                 | 保留；确保不会长任务每轮提醒一次                                    |
| `harmonyos-android-compat` | 明确领域场景                                           | 保留，特定 HarmonyOS 版本状态按需核实                               |
| `stop-slop`                | 英文写作专属                                           | 仅校正 trigger 文案与中文版重叠                                     |
| `red-scribe`               | 用户写作偏好有独立价值                                 | 与 Soul 去耦，建议只在文风任务加载                                  |
| `yuqi-slop`                | 中文语言编辑有独立价值                                 | 与 Soul 去耦，避免模板化禁令取代真正文意                            |

`fewer-permission-prompts`、`ce-code-review` 与 `tdd-flow` 的真实执行需要优先验证，它们的程序性开销潜在大于文字体积成本。

## 5. 技术边界：Skills 加载/播种和前缀

- 公仓 `packages/opencode/src/skill/index.ts` 维护 Skill 发现、frontmatter（`name`/`description`/可选 `paths`）和作用域匹配；`metadata.trigger` 没有被直接当作硬触发路由（不要声称写进 metadata 就会自动调度）。
- `packages/opencode/src/tool/skill.ts` 调用时注入 `SKILL.md` 主文件，附属 reference 列路径但不必全文读取。首次加载可增加该会话后续消息的上下文成本，反复加载还可能重复；默认工具说明已写明同会话避免重复加载。
- 公仓 `script/sync-home.bat` 对 seed Skill 为**缺失时播种，不覆盖 home/私仓存在的 Skill**。因此 `seed/skill/*` 与私仓 live 的相似文件可以不完全一致，但若产品决定保持模板行为同步，须明确单一真源，避免私仓优化后 seed 又播种旧规则给新环境。
- 第三方 `AGENTS.md` / Soul 与 Skill 各自拥有不同职责：Soul 只负责身份关系表达；Agent 负责通用边界；Skill 负责专门任务的手册；项目记忆负责具体历史经验。不要让 Skill 控制 Soul 身份，不让历史事故永久成为所有任务的强制治理流程。

## 6. 最小实施批次（避免大工程）

**批次 A：低风险文字纠偏（优先）**

1. 更正 `fewer-permission-prompts` 的 commit 授权表述和过宽规则示例。
2. 将 `red-scribe` / `yuqi-slop` 的“我是雨琦”替换为 Soul 中立文案；`stop-slop` 收窄英文触发描述。
3. 明确 `ce-code-review` 与 `technical-documentation` 在审查请求下默认只读、不会私自修复。
4. 修正 `config-edit` frontmatter 的绝对表述。

**批次 B：按任务风险收缩流程**

1. 收窄 `ce-code-review` 入口；将完整多评审作为显式 deep 模式。
2. `tdd-flow` 将“TDD 高风险/用户明示”与“认真做”的通用要求分开。
3. `frontend-design` 的 QA 门禁与 `simplify` 的收尾验证从“一律跑”改为“按改动风险”。

**批次 C：高领域知识按需和漂移治理**

1. `apple-design` 若加载频繁，拆长公式和 checklist 到 references；不做未量化优化。
2. `species-design` 与 RedMon 项目规范核对尺寸/路径/字段。
3. `vision-autoagent` 与附件定位事实对齐；不能确定图片归属时不猜。
4. 记忆 DB / 快照查重，确定数据一致性后再考虑删除重复索引。

每批只改对应的 Skill 文件，不触碰核心会话引擎、权限判定逻辑、Compaction、Soul、GitHub CI；安全删除/写库/推送须按现行用户授权规则处理。

## 7. 最小 A/B 验收（成功标准是行为，不是砍掉多少字节）

在**新会话**进行，固定相同模型/variant/工作区与任务；每组先只改一种 Skill 触发或规则，避免混因。

| 场景                       | 旧版常见风险                           | 新版预期                           | 必要证据                        |
| -------------------------- | -------------------------------------- | ---------------------------------- | ------------------------------- |
| RedMon 单一 Move 数值微调  | 误触发 diagnose/TDD/review、反复跑全量 | 局部修改 + 最小合法性验证 + 停止   | tool 序列、检查命令、耗时、结果 |
| 小 diff 的代码审查         | 6 视角、多阶段与非授权修复             | 只读轻量 findings；允许 0 findings | 变更文件数、调用数、无意外编辑  |
| 核心权限/Compaction 修复   | 简化过度导致漏掉关键回归               | 仍能复现根因、验证真实调用链和回归 | 测试、日志、明确失败路径        |
| 任一非雨琦 Soul 的中文润色 | 文风 Skill 夺走身份                    | Soul 保持，文字风格按任务改变      | 可见回复与 prompt 生效记录      |
| 减少 Git 权限弹窗          | 白名单过宽绕过确认                     | 只减少无害误弹；危险动作仍申请授权 | 权限规则评估与实际审核          |
| RedMon 设计新精灵          | 旧固定路径/512px 误导                  | 实时读取项目规则、输出符合当前规范 | 项目文档 + 资源结果             |

建议记录：首轮上下文总量、实际 Skill 加载记录、累计请求 token、任务墙钟时间、工具/测试次数、有效失败/回归数。**不将 37.5K 全部视作 Skill 成本**。不要求所有指标同时上升：保留正确性优先。

## 8. 明确不做

- 不新增“智能 Skill Router”、多层控制器、评分引擎、强制报告模板。
- 不以固定百分比删字节；价值高的领域手册可以长。
- 不把审核请求默认转为代码修改，不把权限降噪当成授予 push、delete 的理由。
- 不把未在当前本机验证的 skill 状态写成已生效。
- 不在同一批同时重写 Soul、AGENTS、Memory、Skill、Compaction，这会让缓存与行为变化无法归因。
- 不强制为了 A/B 新增一堆仓库级 tests/CI gates；用现有日志、针对性测试即可。

## 9. 给雨琦的交接摘要

> 以当前公私仓的最新提交为起点，只对 Skill 做小步减负。先消除 review/TDD 的误触发、写作 Skill 的跨 Soul 第一人称污染、权限降噪示例的危险白名单及 commit 许可矛盾；保留技术专属知识和高风险回归检查。注意今日 `c499c293` 已修记忆五问/编号/单位/DCP，`a1782173` 已修 Soul，不重复做；任何记忆 DB 修改先核快照。先给出精确 diff 与预计影响，分批验证后再请用户批准 commit/push，不新造流程管理框架。

## 10. 关键源码证据导航

- 私仓 Skill 目录：<https://github.com/JiaHuiRed/RedCode-private/tree/master/skill>
- 全局 Agent：<https://github.com/JiaHuiRed/RedCode-private/blob/master/AGENTS.md>
- 新版记忆 Skill：<https://github.com/JiaHuiRed/RedCode-private/blob/master/skill/memory/SKILL.md>
- Review：<https://github.com/JiaHuiRed/RedCode-private/blob/master/skill/ce-code-review/SKILL.md>
- TDD：<https://github.com/JiaHuiRed/RedCode-private/blob/master/skill/tdd-flow/SKILL.md>
- 权限降噪：<https://github.com/JiaHuiRed/RedCode-private/blob/master/skill/fewer-permission-prompts/SKILL.md>
- Skill 加载器：<https://github.com/JiaHuiRed/RedCode/blob/dev/packages/opencode/src/tool/skill.ts>
- Skill 发现：<https://github.com/JiaHuiRed/RedCode/blob/dev/packages/opencode/src/skill/index.ts>
- Skill 播种：<https://github.com/JiaHuiRed/RedCode/blob/dev/script/sync-home.bat>

**总原则**：模型变强了，就减少不必要的过程性约束；但事实核验、用户授权、安全边界不能随之打折。
