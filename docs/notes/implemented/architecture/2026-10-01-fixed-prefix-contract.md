# 固定前缀规则归属与行为评测

状态：implemented（共享契约、工具描述精简及四家真实模型对照已落地）

## 问题

附件方案提出以决策边界重构固定前缀，但其中有几处基线需要修正：

- Inquiry 边界已在 `default.md`；steering 与摘要续接已在 `gpt.md`。第一轮应补缺口、迁移 owner，避免再加一份。
- shell 描述由 `shell/shell.md` 与 `shell/prompt.ts` 生成，task 还拼接 `task.ts` 的 background 说明；只缩四个 Markdown 不足以覆盖工具成本。
- `search_tools` 是当前 builtin/custom 工具目录查询，不激活 MCP 或 deferred tools。GATED 是过滤器。Deferred V2 属于另一次 runtime 工作。
- `PrefixShape` 在最终请求准备前观测，未包含后续加入的模型 prompt、插件转换及最后工具过滤。其指纹和 token 估算不能代替最终 provider 请求或实际 cache usage。

相关既有决策：[公共基线](2026-09-21-prompt-common-base.md)、[owner 收敛](2026-09-24-prompt-instruction-ownership.md)、[GPT 可见声线](2026-09-27-gpt-soul-visibility.md)。

## 决策

### 规则归属

| 规则与触发点                                               | owner                | 第一轮处理                                           |
| ---------------------------------------------------------- | -------------------- | ---------------------------------------------------- |
| 明确要求实现、修改或执行                                   | default              | 工具行动、实现与验证；不能只给方案                   |
| 解释、比较、审计、描述现象                                 | default              | 只读调查并回答；不把问题描述当写入授权               |
| 意图仍不明确                                               | default              | 先做安全只读部分；必要的写入授权缺失才问             |
| 工作困难、首次搜索/验证失败                                | default              | 明确继续条件、真实阻塞和 scope 边界                  |
| 独立调用、依赖操作                                         | default              | 并行方法论归 core；具体链式语法留 shell              |
| 已知文件/symbol、广泛调查                                  | default              | 主查与委派边界；父线程不重复已移交的调查             |
| 小文件、大文件、已确认事实                                 | default              | 足量上下文与总轮次；保留已有事实、避免碎片读取       |
| 用户中途增加约束或问进度                                   | default              | 从 GPT 迁入共享契约；保留其他有效目标                |
| 摘要/压缩完成                                              | default              | 从 GPT 迁入共享契约；续接原任务，不重做完成项        |
| 不可逆、外部动作、拒绝调用                                 | default + 适用政策   | 保留批准边界；已授权不重问；执行器不替模型决定 scope |
| 5+ 文件、仓库操作、Memory 等本机硬边界                     | 全局/项目 AGENTS     | 本轮不改；更严格的政策仍优先                         |
| 参数、workdir、引号、shell 差异、截断恢复、Git 命令构造    | shell contract       | 保留工具独有知识，删长篇通用方法论与重复示例         |
| task 的 fresh/resume、background、隔离、返回语义           | task contract        | 保留真实 API 语义；缩短附加 background 说明          |
| GPT 的可见声线、Step 原生工具通道、DeepSeek/GLM 已证实纠偏 | model delta          | 保留；不因字面相似机械删除                           |
| 称呼、关系、语气、情绪                                     | soul                 | 不改；工程契约不重新规定人格                         |
| 经验全文、专门知识、低频能力                               | Memory / skill / MCP | 不搬回 core，不改工具加载机制                        |

五层职责图描述 owner，不规定 wire 顺序。现行部分模型使用独立 prompt，未继承 default；工具契约瘦身仍需保留简短的适用范围与专用文件工具指引，不以四个主模型的继承关系推断其他模型也继承 core。

### 冻结与实验

- 首次冻结时主树 HEAD 为 `8d880710`，包版本 `0.11.17`。冻结九个可编辑来源的原文、SHA-256、UTF-8 bytes，并渲染 bash/pwsh/PowerShell 5.1/cmd 四种 shell 契约。冻结副本在本机 `.redcode/temp/prefix-before.json`；它是本次实验产物，不是长期配置。
- `Token.estimateReporting` 只用于同一统计口径的前后对照，不能报告为 provider 精确 tokenizer 数。
- 四个评测家族为 GLM、DeepSeek、GPT、Step。使用当前 registry 的真实模型 ID、认证与生产 LLM 请求链；不用默认 cassette replay 冒充当前真实调用。
- 行为实验只提供内存文件和虚拟工具。模型不能运行 host shell、写真实文件、执行真正的 commit/push、启动 MCP 或改变用户配置。
- OAuth 只读现有有效凭据；过期或接近过期时报告阻塞，不刷新、不旋转、不持久写回。
- 全局配置与认证只用于解析当前连接；绝不记录 provider/auth 对象、secret 或请求认证头。

### 行为用例与评分边界

`packages/opencode/script/prompt-eval-cases.ts` 提供 18 个固定 case：

action、inquiry、audit、audit-fix、ambiguous、failed-check、search-miss、known-file、independent-reads、small-file、steering、status-question、compaction、authorization、outward-boundary、delegation-ownership、scope、denied-tool。

评分依赖虚拟文件最终值、真实工具调用记录、验证状态与终止状态。JSON 格式不参与评分；缺文件或非法 JSON 给失败原因。评分器自身有正负控制，不能把它的单测通过当成模型行为通过。修改后的读回验证、补丁上下文不匹配后的复核均不算“无新证据的重复读取”；这些判定修正对新旧记录统一重算，原始记录不覆盖。

本实验的人工 history 只测摘要/中途消息的指令续接，不是实际执行期间 steering、真实 DCP compaction 或完整 GUI/TUI 端到端测试。没有加载 AGENTS、Memory、soul、skills、MCP 和完整生产工具表；task 行为输入也未拼接 background 附加描述。虚拟工具环境不能证明全前缀缓存命中、真实 Git 正确性、人格声线或大型仓库任务完成率。

## 改动与成本

| 来源/契约                                    | 旧 → 新 UTF-8 bytes | 旧 → 新估算 tokens |
| -------------------------------------------- | ------------------: | -----------------: |
| default.md                                   |       6,914 → 9,518 |      1,702 → 2,353 |
| gpt.md                                       |       3,171 → 2,631 |          773 → 638 |
| glm.md                                       |           388 → 388 |            97 → 97 |
| deepseek.md                                  |           612 → 612 |          153 → 153 |
| step.md                                      |       2,047 → 2,047 |          511 → 511 |
| task.md（不含附加说明与 schema）             |       2,476 → 1,268 |          619 → 317 |
| task background 附加文本                     |                   — |           204 → 85 |
| shell/bash（description + schema）           |       5,854 → 2,908 |        1,464 → 727 |
| shell/pwsh（description + schema）           |       6,658 → 3,329 |        1,665 → 832 |
| shell/PowerShell 5.1（description + schema） |       6,530 → 3,415 |        1,633 → 854 |
| shell/cmd（description + schema）            |       5,845 → 3,067 |        1,461 → 767 |

在 pwsh、task 可用且 background 附加文本启用的相同集合中，局部净减少：GPT 约 738 tokens，GLM/DeepSeek/Step 约 603 tokens；background 未启用时分别约 619 / 484。default 增加约 651，用于明确决策边界；工具描述与 GPT 共有段落的节省覆盖了这部分增长。

来源 TS 文件大小不算注入 token；background 文本按冻结 TS 中的静态字符串表达式解析。上述局部统计不等于附件的 42K 全前缀基线，也不表示已实现 Deferred V2 或全工具表 22–26K 目标。GLM/DeepSeek/Step delta、shell.md 的 Git 安全条款、参数约束、执行权限、截断运行时和注入顺序均未改。

## 四家真实模型对照

每家使用相同的 18 个输入、人工 history、文件和失败控制；每侧只采样一次，不能当统计显著的提升。temperature 为 0，但服务端仍可能非确定。

| 实际 provider/model               | 旧 → 新通过数 | 旧 → 新工具调用数 | 新版未通过用例                             |
| --------------------------------- | ------------: | ----------------: | ------------------------------------------ |
| zhipuai-coding-plan/glm-5.3-flash |  16 → 17 / 18 |           46 → 56 | audit-fix：没有运行指定 verify             |
| deepseek/deepseek-flash           |  15 → 16 / 18 |           71 → 71 | compaction、delegation-ownership：重复读取 |
| openai/gpt-6.1-sol                |  17 → 17 / 18 |           43 → 44 | failed-check：第一次验证失败后未继续验证   |
| stepfun-step-plan/step-5-preview  |  16 → 17 / 18 |           65 → 62 | compaction：重复读取                       |

DeepSeek 模糊询问中的尝试写入在本次新版样本未再出现；GLM/Step 的已完成委派调查重复执行也未再出现。GLM 新版增加了调用、Step 新增摘要后重复读取，因此不宣称整体更快或所有行为都改善。请求耗时只作原始记录，不作受控性能结论。

### 记录与复算

- 本机旧版：`.redcode/temp/prompt-eval-before-{glm,step}/before.jsonl`、`prompt-eval-before-gpt-final/before.jsonl`、`prompt-eval-before-deepseek-official/before.jsonl`。
- 本机新版：`.redcode/temp/prompt-eval-after-{glm,step}/after.jsonl`、`prompt-eval-after-gpt-final/after.jsonl`、`prompt-eval-after-deepseek-official/after.jsonl`。
- 每条记录保留输入、history、system、工具定义、调用/结果、虚拟文件、终止/验证状态、usage 和哈希。后续入口还在每轮发送前持久化 `<label>.requests.jsonl`，让超时与结果写入失败轮次的模型可见输入也可重建。
- 输入/文件/失败控制 checksum：`d9a761b95bf9ecf999c21bd99aa66726e0ad5b1d0705b33cfdce229236c2d491`。前三家旧记录早于此字段，通过原始输入/history比对及已保留的用例来源哈希复核。用例源码哈希会因评分修正、格式化改变；这不等于输入变化。
- 旧 GLM/Step 请求曾设置 native opt-in，但这些接入不支持 native，实际回退 SDK；GPT 与官方 DeepSeek 的有效对照均走 SDK。Codex 必须复用官方 auth loader、`chat.headers` 和 `chat.params` 两个协议 hook，禁止 OAuth 刷新和真实 server 调用。
- 接入诊断不计行为失败：早期 DeepSeek 中转 403/402/429，最后改用已注册且认证的官方 `deepseek-flash`；GPT 的最初 400 来自评测入口漏接协议 hook，已修后重跑旧版。新版曾出现一次 HTTP 200 流中请求错误，同输入烟测恢复后重跑全组，原始异常记录保留；没有挑选最好分数覆盖记录。
- 可重复入口在 `packages/opencode` 下运行，例如 `bun script/prompt-eval.ts --models deepseek/deepseek-flash --snapshot ../../.redcode/temp/prefix-before.json --output ../../.redcode/temp/prompt-eval-new-run --label before`。使用新的输出目录/标签，避免追加混入另一轮结果。冻结副本和完整原始结果是本机实验产物，不随本 note 自动同步。

## 模型可见改动四问

1. **内容**：default 首句 `Use your tools to make real changes; do not just describe what could be done.` 改为 `For action requests, use your tools to deliver the requested result. For inquiries, investigate and answer within the requested scope.`，消除与只读询问边界的冲突。新增完成/阻塞条件、总上下文成本、委派 ownership、已有授权与外部批准边界；GPT 的中途消息、摘要续接与不交付半成品迁入 core。新增共有段放文件末尾；原回复、证据与 soul 规则保留。shell 删除长篇通用并行/文件路由示例，保留四种 shell 的引号、链式语法、workdir、目录验证、超时与全文 spill 恢复；task 保留 fresh/resume（explore 不接受 task_id）、隔离及用户不可见结果语义，background 长段缩为四句。
2. **token**：上述前后表与局部净值为 `Token.estimateReporting` 同口径估算。**default 单项约 2,353 tokens，超过 1K**；它承载四家共享的意图、停止、证据与可见交付契约，保留用户已有规则，没有为求短而删。未修改 soul/global/project AGENTS/Memory、skills/MCP 指南，不冒充全前缀测量。
3. **KV cache**：default 首句已有变化；工具 description/schema 的说明文本也变化，旧前缀需重建一次。具体失效起点由 provider 对 system 与 tools 的序列化决定，不能声称只从追加段起失效或固定省同样 cache tokens。没有改变工具排序/pinning/集合或 wire 层；没有做真实全前缀缓存 A/B。本次样本记录实际 usage，但不能由此定位哪段命中。编译内嵌 prompt 的运行实例需重新编译/重启并开新会话才加载新版本；本轮未重编或重启 GUI/TUI。
4. **硬上限**：生产新增项是有限编译期字面量；default 当前 9,518 UTF-8 bytes，四种 shell 的描述加 schema 均小于 4 KiB。未新增动态注入来源。实验来源每项 64 KiB、冻结文件 1 MiB、会话消息 512 KiB、工具输入 64 KiB、工具结果原文 8 KiB 加固定截断标记、结果/每轮请求日志单项 1 MiB；最多 16 个模型、每模型 18 个 case、每 case 32 轮。每请求超时默认 120s/最高 600s，事件字节上限默认 128 KiB/最高 1 MiB，均经 CLI schema 校验。Codex 协议 hook 移除 maxOutputTokens，因此事件字节与轮次边界仍必须独立保留。未借用 instruction budget 声称整个生产请求已受限。

## 备选与否决理由

- **先改完再建立旧版基线**：否决——无法区分改动收益、模型随机性和实验环境差异。
- **把所有安全规则都交给执行器，从 prompt 删除**：否决——批准准备工作、外部动作和 scope 的边界仍需要模型判断。
- **只增不减工具集合即保证 cache**：否决——新增工具仍改变 provider 序列化；当前 runtime 也没有这种加载机制。
- **全量重写所有模型 prompt、global AGENTS 或 soul**：否决——扩大影响面；没有四主模型以外的行为证据。
- **顺手修 MCP cache stub 连接**：否决——属于独立连接/时序问题，不混进提示词语义重构。

## 验证

- 旧版 `test/session/system-prompt-routing.test.ts`：11 pass。
- 重构前先建立红断言：共享契约区块与四种 shell 描述预算共五个预期失败；重构后转绿。
- 定向三文件共 36 pass：routing 12、评分器正负控制 18、shell 描述/参数契约 6。PowerShell 5.1/7、cmd 的差异分别验证。
- 当前 `bun run typecheck` 通过。早先的三条 currency 错误已不再出现在最新主树检查中；没有改动相关路径。
- 四家真实调用各完成新旧 18 例，共 144 个有效对照 case；不是 144 次请求，工具回合会发多次请求。诊断烟测和接入错误另计，不混入通过数。
- 未跑全量测试、未升版、未推送、未 release；端到端与全前缀缓存证据边界见上文。
