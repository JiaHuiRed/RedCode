# 提示词规则按 owner 收敛

状态:implemented

## 问题

提示词把通用工作法同时放在全局 AGENTS、项目 AGENTS、runtime WORK RULES 和 live soul，出现相互冲突或职责重复。`system.ts` 还规定称呼频率与 reasoning 用语，与 soul 的自然称呼风格冲突。两份 MEMORY 超出各自注入预算。

## 决策

- **owner 分层**：`default.md` 拥有常规执行与 routine assumptions；全局 `~/.redcode/AGENTS.md` 拥有跨项目硬边界和 Memory 资格规则，并明确何时打断默认路径（材料性歧义、缺失信息、不可逆操作才问）。纠正后落实并验证；调查范围按影响面，未知根因/跨模块/高风险问题才扩展，深诊断阶段由 diagnose skill 拥有。
- **项目 `AGENTS.md` 只保留 RedCode 仓库规则**：删掉“先读代码、失败后诊断、承认能力边界”通用 CORE，owner 分别是全局工作法、default prompt 和 diagnose skill。
- **runtime `prompt.ts` 删除两个 owner 明确的重复项**：移除 CORRECTIONS ARE ACTIONABLE（全局 AGENTS 已有明确 owner）和 AFTER ANALYSIS → EXECUTE YOURSELF（default prompt 的执行范围 + 全局提问边界已有 owner）；保留 #1/#2/#3。#1/#2 的权威 owner 仍是全局 AGENTS，保留 runtime 镜像不代表重复规则能增权——这仍是未验证假设。
- **称呼风格归 soul**：`system.ts` 不再要求正文或 reasoning 的称呼频率，只注入 `Preferred form of address: …`。`config.username` 不设长度上限，因此 `addressFrom()` 在 prompt 边界截为最多 128 个 Unicode code point（UTF-8 不超过 512 bytes；当前 context estimate 上界 64 tokens），配置原值不变。
- **live soul 保留人格，移除通用工程工作流**：Tsoul 的读文档/写经验清单改为个人求知习惯；Gsoul 的抓 bug、纠错后修复、实验步骤改写为性格反应；两边移除“工程规则由 Agent/Model Prompt 决定”的元说明。口吻、关系和情绪表达保留。
- **Memory 剪枝只压缩、不淘汰有效索引**：全局 MEMORY 保留全部索引号；将已提交的 capsule L1-L6 状态从项目 MEMORY 移入 `.redcode/MEMORY-archive.md`；#302 正文保留在数据库并规范标题编号，随后导出备份快照。

## 备选与否决理由

- **继续在各层重复规则并依赖模型自行裁决**：否决——三处全局内部矛盾已有实际 owner，重复只扩大解释空间。
- **一次删掉全部 runtime WORK RULES 或重写所有模型 prompt**：否决——#3 是明确的用户决策权护栏；#1/#2 保留，模型 delta 也不在本次范围内。
- **把 live soul 整体改成通用人格模板**：否决——会抹掉维护者明确偏好的角色声音；只移除真正越界的工程流程。
- **让任意长度 username 原样进入 system prompt**：否决——这是配置来源的模型可见输入，必须有硬上限；仅限制注入副本，不修改配置。

## 后果

- UTF-8 文件字节变化（旧值按编辑前实测/HEAD，非 tokenizer 的精确 token 数）：

  | 注入层 | 旧 → 新 | 变化 |
  |---|---:|---:|
  | 全局 AGENTS | 17,179 → 17,488 | +309 |
  | RedCode 项目 AGENTS | 14,737 → 14,174 | -563 |
  | 全局 MEMORY | 13,786 → 10,978 | -2,808 |
  | 项目 MEMORY | 9,040 → 5,631 | -3,409 |
  | Tsoul | 5,675 → 5,174 | -501 |
  | Gsoul | 5,246 → 4,764 | -482 |

- 全局 AGENTS 净增是有意的：用更短的明确判据替代相互冲突的口号，不把字节变少误当成唯一目标。Memory 与 soul 共减少 7,200 bytes；项目 AGENTS 减少 563 bytes。文件字节数不是模型 token 数；`ContextSnapshot` 的 token 估算为 `round(chars / 4)`。
- runtime WORK RULES 删除的 #4/#5 正文共 358 个字符，按 `Token.estimate` 约 90 tokens（完整 block 的 round 差异最多 1 token）；称呼指令则由两段带行为要求的文本改为一条偏好事实，具体节省随配置 username 长度变化。
- `default.md` 与各模型 Delta 未改。对当前有称呼配置的会话，首个变化位于模型 prompt 之后的 `<env>` 地址事实；从该字节起至请求尾部的前缀需要重建，前面的 default/model Delta 仍可复用。若地址为空或被识别为系统用户名/主机名，最早变化点是全局 AGENTS；每日日期仍留在原来的 prompt 尾部。
- “重复规则会增权”及模型人格变化仍属未验证假设；本 note 只记录静态 owner 变更，不将其写成实测结论。
- 回归命令 `bun test test/session/system.test.ts test/session/reasoning-language.test.ts test/session/system-prompt-routing.test.ts --timeout 30000`：40 pass；Prettier 检查 `src/session/{system,reasoning-language}.ts` 与 `test/session/system.test.ts` 通过。全局 MEMORY dual-write 检查通过。TUI 全包 typecheck 此前连续两次因 tsgo 崩溃后 TypeScript fallback OOM，未再次运行。
- 同任务试跑只得到 Luna 样本：两次读文件、一次实现编辑、`bun test test/filter.test.ts` 2/2，随后简短收尾；请求记录显示 context 约 35.5K tokens、缓存读 34.3K、cost=0。Sol 启动后未留下输出、会话或新日志，期间系统可用 commit 从 1.15 GB 降至 0.71 GB；没有证据确认退出根因，因此不重试，也不据单个 Luna 样本推断模型差异。

## 2026-10-07 GPT Delta 精简

- `gpt.md` 的 Progress updates、Voice、Writing style、Formatting 段重复 Soul 与 common prompt 的沟通、称呼和格式 owner；GPT Delta 只保留 GPT 真实的工具/API差异，重复人格规则回归 Soul owner。
- 旧/新 `gpt.md`：2,531→780 字符，减少 1,751 字符；按 `Token.estimate`（`round(chars / 4)`）估算 633→195，减少约 438 tokens。没有增加任何模型可见内容。
- 缓存影响：仅对 GPT 请求，从 gpt.md 所在的模型 Delta 起至 system 尾部重建一次；default、AGENTS、MEMORY、Soul 等更前面的字节未改，非 GPT 请求完全不变。
- 无新增运行时配置或动态注入；该 Delta 是固定源码，token 上限由静态文件长度确定。


## 2026-10-07 意图规则收窄与 soul 保留顺序

- `default.md` 意图判断收窄：编码会话中具体 bug 或行为偏差且有明确预期结果时默认做受限修复（哪怕以提问形式提出）；显式 audit/explain-only 保持只读；意图或安全范围不清时先做最小调查再问。旧措辞把「描述问题/提问」一律判为只读分析，是「找到原因却不改」这类抱怨的直接来源。
- 运行时 WORK RULE #1 改为「不要编造代码事实：只检查与本次请求相关的未知路径/API/行为」——旧措辞与默认提示词重复，且强化了「先调查」的误读。
- instruction 超预算保留顺序重排为 `{ agents: 0, soul: 1, memory: 2, config: 3 }`（丢序 config → MEMORY → soul → AGENTS）。旧序 soul 最先丢，但它是身份核心、丢了无补救通道；MEMORY 是索引层、全文在召回库可查。本机五源合计已达默认预算约九成，此改在溢出时生效。
- 模型可见四问：① 内容变化仅 default.md 与 runtime WORK RULES 各一处改写文本，注入结构不变；② 固定前缀 token 为两处单行改写的小幅增减（未做精确 tokenizer 计数）；③ 缓存从两处所在段起各失效一次，RETENTION 只改丢弃顺序、不改输出字节与注入顺序；④ 上限均为固定源码文本，无动态注入。
- 验证：`instruction.test.ts` 先临时反置 RETENTION 验证新用例红（1 fail），恢复后 22 pass / 0 fail（62 expects）；TUI `bun run typecheck` exit 0。
## 2026-10-13 更新：RETENTION 三项化，soul 移出 instruction 预算

上文「2026-10-07 意图规则收窄与 soul 保留顺序」一节记录的 `RETENTION = { agents: 0, soul: 1, memory: 2, config: 3 }` 已失效。Soul System V2（`implemented/architecture/2026-10-07-soul-system-v2.md`）把 soul 改为会话绑定、经 `session/soul.ts` 独立注入，不再经过 `instruction.ts` 的来源预算；现行 `session/instruction.ts:38` 为 `RETENTION = { agents: 0, memory: 1, config: 2 }`，`cli/cmd/doctor.ts:92` 明示 soul "excluded from instruction budget"。本文 owner 分层、称呼截断（128 code point / 512 bytes）等结论不变。

## 2026-10-25 交付契约覆盖全部默认模型路由

> 本节记录 `7f80667c` 初版；全模型注入已由文末「仅 GPT 与 Step 定向调优」撤回，不再是现行范围。

### 证据与决策

`32cdee56` 把「交付不能降级为核查」「不造无依据的护栏」「最小完整变更」放在 GPT Delta，
同一段真实会话后半程却换到了 Step。核查替代交付、绕过既有工作流另造逐项探针、失败后
反复换启动方式、把可执行工作交回维护者，以及复盘时丢掉 Soul 称呼，不能只给 GPT 修。
原先的固定三项报告要求也不应覆盖 Soul 和实际问题所需的回答形状。

- `working-style.md` 拥有这组跨模型交付与交互契约，`system.ts:provider` 在现有各模型提示词
  **末尾追加一次**。14 个代表路由（含独立档、本地 Qwen、sensenova 和未知模型）检查同一入口。
  不重写其它家族的旧档；显式自定义 `agent.prompt` 仍按原契约替代默认模型提示词。
- GPT Delta 移除通用 Working style，只保留工具和编辑差异；公共段规定使用现有工作流、
  验证匹配改动、完成已要求的产物与依赖素材、长任务后台执行、进程操作先自证归属。
- 交互遵循 Soul 的称呼，覆盖正文和复盘；受批评时回答尚未解决的实际问题并执行，
  不用判定维护者「说得对」或编造认错故事代替修复。没有硬编码具体人格称呼。
- **不把提示词当强制执行器。** 「编辑器」特例和「必须同步撤回旧推测」的追加句已撤回。
  当场纠正已经没被遵守，再抄成更强烈的禁令不是机制修复；本批没有实现自然语言事实真伪门禁，
  也没有自动改写输出、额外裁判模型或后台重试。

### 验证与边界

- 路由回归先红后绿；`system-prompt-routing` + 既有 eval oracle 共 33 pass，包级 typecheck 通过。
- 真实模型探针沿用 `script/prompt-eval.ts` 的隔离虚拟文件与工具，不接触真实仓库或设备。
  两个场景分别是「受批评后直接完成改动」和「纠正错误说法、回答进度后继续实现」，
  同时检查实际改动、一次既有 verify、称呼及套话。输入、工具表、请求和结果均落盘；
  本机载体为 `.redcode/temp/interaction-eval-{gpt,step}-261025/`。
- 验证器原来只回放 tool-call，丢掉同轮 assistant 正文，导致后续模型看不见已经给过的说明。
  已补回正文；修改前的重复解释样本不能当作生产模型重复行为的可靠结论。
  验证器新增 `--variant`，可按真实会话的 high 档复测，选择值必须在该模型 variants 中存在。
  判定失败同时设置非零退出码，不再只在 JSON 里写 errors、终端却返回成功。
- 修正回放后，GPT 默认档与 high 档的两个场景均实际修改并验证通过，未触发称呼/套话检查。
  Step 两档都完成改动、只运行一次 verify，并使用 Soul 称呼，但进度场景仍出现一次套话，
  **因此不能宣称跨模型交互已全部修好**。同义禁令不再叠加，这项保留为实测限制。
- 原会话最后一次压缩早于后续争议和纠正，不能指称纠正被该摘要吞掉。持久化请求日志只有
  指纹而非完整 wire 正文；数据库时间顺序和当前组装代码不足以证明那次逐字送达，
  因此不把「模型当时一定收到」或「引擎丢消息」写成已确认根因。

### 模型可见四问

1. **看到什么变了**：旧 GPT 独有 `The deliverable is the change, not a report` 等七条通用工作法
   移入公共段并按上述行为重写；删除 `A completion report contains exactly three things`，
   改为 `Concision must not erase the soul or omit a material limitation`。非 GPT 默认路由新增
   同一份交付契约，不复制各家完整提示词；语言、人格名字和称呼仍取 Soul。
2. **token 影响**：共享文件 3,538 UTF-8 bytes，`Token.estimateReporting` 估算 883 tokens；
   GPT 文件 2,944→780 bytes，合并共享段后固定前缀净增约 347 tokens；其它默认路由净增约
   883 tokens（拼接取整可差 1）。均为估算，不是供应商 tokenizer 实测。
3. **KV cache 影响**：非 GPT 在原模型提示词末尾追加，从新增段开始到其后 environment、
   instructions、Soul 等请求尾部需重新建一次缓存；原模型提示词字节不改。GPT 因移除旧
   Working style，从 GPT Delta 的该节起变化。不是「只多 883 token、不影响后续前缀」。
   tools、历史消息和轮中缓存结算机制不改。
4. **硬上限**：新增段是固定源码文件 3,538 bytes，不拼接运行时输入，已登记
   `delivery-interaction-contract`；低于单项 1K 估算 token 点名线。eval 原有请求 1 MiB、
   会话 512 KiB、响应字节和轮数上限保持，新增 variant 也记入请求日志。

## 2026-10-25 更正：仅 GPT 与 Step 定向调优

- **撤回全模型推广**：失效证据来自 GPT 与 Step，不能据此认定 DeepSeek、GLM 等也需要同样的
  执行和回应约束。各家训练与推理方式不同；把纠偏文案命名为通用契约不会使其天然适用于所有模型。
  本次没有证据表明其它模型已经变死板，因此记录的是风险与范围纠正，不伪称实测回归。
- **现行范围**：`system.ts` 只在已有 GPT、Step 分支调用 `withDeliveryPrompt`；其余分支继续
  原来的 `withDefaultPrompt` 或独立档。DeepSeek、GLM 的基线、专属 Delta、推理锚全部保留。
  GPT/Step 最终提示词内容与 `7f80667c` 一致；其它家族撤掉新增段，恢复该提交之前的组合。
  `script/prompt-eval.ts` 同步限定范围，避免验证器仍对 GLM/DeepSeek 拼接生产中没有的段。
- **跨模型影响不等于思维链共享**：现行 `message-v2.ts` 对不同模型的结构化 `reasoning`
  整段剥离，正常 text、工具历史及摘要仍保留，后者可能带入旧回复的风格与假设。本机独立 Step
  探针没有 GPT reasoning，仍复现套话，说明 GPT 思维链不是复现该倾向的必要条件；
  不据当前源码和短样本反推旧运行实例的逐字输入或唯一根因。
- **验证**：新增其它家族不得继承该段的回归先红后绿；路由 16 pass、跨模型推理剥离相关
  4 pass、包级 typecheck 通过。其余家族的原提示词文件和推理锚没有修改；不为这次范围回退
  重跑全部模型行为评测，也不将静态路由验证说成其它模型的行为收益证明。
- **模型可见四问**：
  1. GPT/Step 内容不变；DeepSeek、GLM 及其它家族不再看到新增交付与交互段。
  2. 相对 `7f80667c`，GPT/Step 固定前缀增减为零，其它家族减少约 883 估算 tokens。
  3. GPT/Step KV 前缀不变；部署过全模型初版的其它家族从移除段处起重建一次。
     未部署过初版时，其它家族直接维持初版之前的前缀。
  4. 无新增注入；原固定文件 3,538 bytes 上限不变，登记项改为仅 GPT/Step 条件注入。
