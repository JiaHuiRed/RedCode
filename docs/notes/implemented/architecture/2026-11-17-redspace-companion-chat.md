# RedSpace 第一阶段：两种产品模式，共享个人档案接续

状态：implemented（0.19.0 首批源码；浏览器 / Electron 与真实模型体验验收另列边界）

## 问题

RedCode 的 Soul 定义会话身份，工程记忆维护开发经验；OpenClaw / RedClaw 的个人档案还包含长期关系、共同经历和日记。把 MEMORY 直接拼进 Soul，既混淆两者的生命周期，也超过现有 Soul 文件 16 KiB 限额。重新创建一个相似人设同样无法继承已有经历。

用户要求以维护更频繁的 RedCode 为基础形成 RedSpace，只有 Chat / Code 两种产品模式；两者都可执行工具。Chat 接续既有伙伴，Code 继续使用原有 Souls。TUI 是同等重要的入口，当前不能要求用户为了 Chat 改用 GUI。

本决策取代 `docs/notes/proposed/architecture/2026-09-18-studio-mode.md` 中「第四个 posture」和「按客户端选择 Soul」的拟议路线。现行 Soul 内容版本冻结机制仍由 `2026-10-07-soul-system-v2.md` 负责。

## 决策

后续补齐见 [同伴限定的会话原文召回](../feature/2026-11-17-companion-session-recall.md) 与 [旧聊天导入及记忆分页](../feature/2026-11-17-companion-transcript-import.md)。下文「原始 JSONL 不在首批」描述首批边界；现在可重新导入同一来源，追加可识别的旧聊天文本并保留已有日记。

### 1. 产品模式属于会话，UI 只导航

`Session` 新增 `mode` 与 `companionID`。数据库通过 Drizzle 生成的增量迁移增加两列，已有行默认为 Code；没有重建会话或消息表。对旧客户端和事件，缺失 mode 仍按 Code 理解。

| 会话 | 身份归属 | 记忆来源 | 执行权限 |
| --- | --- | --- | --- |
| Code | 现有 Soul 选择及冻结正文 | 现有全局 / 项目工程记忆 | 现有 Plan / RedMind / Auto |
| Chat 主会话 | 显式 Companion → 固定 Soul | 该伙伴的个人档案 | 现有 Plan / RedMind / Auto |
| Chat 派生子任务 | 继承父会话身份 | 不自动携带个人档案或个人记忆工具 | 现有子代理规则 |

Chat 根会话只允许在绑定档案目录创建；缺失档案、错误目录、混用 Code 与 companion、冲突 Soul 均明确失败。fork 保留归属，已有会话没有热切换 mode / companion API。切换顶栏或 TUI 命令只改变导航，不改变既有会话的身份。

### 2. 一个服务供两端使用

共享 `Companion.Service` 负责导入、资料列表、上下文快照、搜索、分页读取和追加日记。HTTP 增加 `GET /companion` 与 `POST /companion/import`，只向列表返回资料摘要；SDK 与 OpenAPI 同步生成。

| 能力 | TUI | GUI |
| --- | --- | --- |
| 导入 | `redcode companion import <source>` | Chat 页目录 / ZIP 选择或服务器路径 |
| 查看已有伙伴 | `redcode companion list`、`/chat` | Chat 页档案列表 |
| 进入 | `--companion <id>`、`/chat` | 显式绑定创建 / 续接会话 |
| 切回开发 | `/code` 工作区选择 | 顶栏 Code |
| 新建 Chat | `/new` 保留伙伴 | `/new`、顶栏 `+` 保留伙伴 |
| 恢复 | Chat 只续指定伙伴；普通 `--continue` 只续 Code | 按后端 mode / companion 筛选 |

两端连接同一后端、同一本机数据目录时共享档案。没有新增跨机器同步承诺。TUI remote attach 暂不开放依赖本地目录切换的 `/chat`、`/code`；命令不会假装切换成功。GUI 在会话绑定加载前不写 Code 的最近项目，避免把私人档案注册成最近开发目录。

### 3. 来源保留与活动资料分开

默认布局为 `~/.redcode/companions/<id>/source/`、`workspace/` 和 `profile.json`。选择导入的原始个人文件保留原字节；活动资料从这些来源复制，随后可继续写入。身份正文注册到既有 Soul Registry，原始图片保留但本阶段没有将旧头像转成 UI 资产键。

导入支持完整 OpenClaw home、workspace 目录及 ZIP。完整 ZIP 通过文件范围 Reader 读取中央目录和选中的 entry，不把整个压缩包一次载入内存。初版整包 Reader 在重复导入真实大档案时被系统终止；范围读取修复后完成导入与重复导入验证。

- SOUL 是固定身份；USER / IDENTITY、MEMORY、日期日记是个人资料来源。
- 旧 AGENTS 与安装的技能只保留为来源，不自动成为 RedCode 指令或可执行插件。
- HEARTBEAT / TOOLS 等机制资料可以保留，但不会重新注册任务、渠道或权限。
- 网关密钥、设备认证、渠道 token、缓存数据库和其他机器运行配置不进入活动档案。
- 原始会话 JSONL / trajectory 的完整语义迁移不在本阶段。系统事件、梦境、已删除历史与真实用户话语需要分开解释，不能把所有 `role:user` 当作用户说过的话。

同 ID、同来源摘要重复导入返回 `imported: false`；已经续写的记忆保持不变。不同来源占用同 ID 返回冲突。超限、无效编码与不支持的迁移项给出可见说明；不能可靠解码的文件保留原文，不生成伪造的替代记忆。

### 4. 启动快照与选择性记忆

Chat 主会话在 Soul 后加载有界资料快照：USER / IDENTITY 各 1 KiB、MEMORY 至多 24 KiB、最近两篇日记尾部各 3 KiB，总计仍受 32 KiB 限制。快照按会话 / 模型桶缓存，避免每轮重新拼装不断变化的全文。需要旧经历或最新内容时使用个人记忆工具；新会话或冷启动重新读取档案。

`companion_memory` 只在绑定的 Chat 主会话提供：

- `search` 返回有来源行号的片段，最多 10 条；扫描最多 8 MiB，序列化结果最多 8 KiB。搜索先枚举实际来源并校验读权限，随后只搜索本次已获准的路径快照。
- `read` 有行号与字节续读游标，原文最多 16 KiB。即使单行超限或文件使用 CRLF，也可用 `nextByteOffset` 接续，不以截断前的 endLine 跳过未返回内容。工具输出第一行是 JSON 来源 / 游标元数据，后接原文，避免原文 JSON 转义造成不必要膨胀。
- `remember` 将至多 8 KiB 的精选内容追加到档案时区的日期日记，记录会话 / 消息来源与幂等键。批准时校验真实目标日期路径；等待权限期间跨午夜也沿用已批准的目标。进程内串行与跨进程文件锁保护两端并发追加，重放不重复记录。读写均检查实际路径边界。

复审删除了最初的「每轮结束自动复制用户 / 助手摘录」实现：它会在用户明确不想记住、或拒绝 remember 权限后继续写日记，也会把过程片段当作长期经验。现在长期记忆统一经工具选择性续写，提示词要求遵守不保存的意图；普通聊天消息仍由原 Session 机制保存。没有用关键词规则猜测用户是否允许保存。

Chat 不加载核心 Instruction 的全局 / 项目工程 MEMORY，也不注入工程记忆维护条款。全局指令、用户配置的工具 / 插件与权限体系仍有效；用户自行安装的第三方记忆插件不属于本次迁移器的管理范围。Code 请求继续原有路径。

Chat 不继承全局 Code 的自动公开分享行为；显式分享功能保留。

## 模型可见四问

1. **模型看到什么变了。** Code 的 provider prompt 与工程 MEMORY 路径不变。绑定主 Chat 使用 `session/prompt/chat.md` 替代 coding provider base：从「You operate through RedCode, an interactive coding environment…」变为「You are in RedSpace Chat. Your identity, voice and relationship…」。既有自定义 agent.prompt 接在 Chat 契约后；人格仍只来自固定 Soul。Soul 后新增个人资料快照，并增加一个 `companion_memory` 工具。子任务不注入个人资料。
2. **token 影响。** 当前 Chat 固定契约 1,941 UTF-8 字节，`Token.estimateReporting` 估算 485 token；旧 default.md 为 9,947 字节 / 2,478 估算 token。以没有自定义 agent.prompt 的 GPT 路由为例，替代 default + gpt + working-style 后，这一基线约减少 2,702 估算 token，再加实际个人资料和工具定义；不同模型净值不同，不能宣称所有请求统一增减。个人快照和 read 输出均是可能超过 1K token 的明确新增项；不是把整个档案或全部历史加入每轮上下文。估算器不是模型 tokenizer，字节上限才是运行时硬约束。
3. **KV cache 影响。** 新 Chat 从最前面的 agent/provider base 起使用独立前缀。Code 不因本次模式分支改变已存在的 provider 前缀。个人快照在会话 / 模型桶内稳定；写记忆不会热改当前桶。新会话、模型新桶或进程重启时重读最新文件，资料变化会使 Soul 后的对应后缀重新缓存。工具结果追加在历史尾部。Soul 内容版本仍按原有机制冻结。
4. **硬上限。** Soul 沿用 16 KiB 文件与既有包装上限；个人快照总计 32 KiB；search 的整个 JSON 结果 8 KiB、扫描 8 MiB；read 原文 16 KiB，连同受限路径和游标元数据小于 20 KiB；remember 正文 8 KiB，单日文件 4 MiB。导入压缩包最多 512 MiB，所选文件最多 4,096 项 / 64 MiB，单来源文件 8 MiB；模型读取文本单文件 4 MiB。超限结果明确标记或失败，没有无界全文注入。登记见 `docs/injection-registry.jsonc`。

## 备选与否决理由

- **第四种执行 posture**：产品模式与权限策略不同，新增 posture 不能稳定承载跨端的伙伴身份。
- **把 MEMORY 拼进 Soul**：混淆固定身份与增长经历，触碰 Soul 大小上限，也破坏会话人格版本语义。
- **整体移植 RedClaw 网关和调度器**：第一步会同时引入两套权限、会话和客户端生命周期；先接续个人资料与日记有清晰的验收链。
- **自动复制所有可见对话到日记**：拒绝保存与编辑权限不应被旁路，日记应保存精选经历而不是第二份无条件逐字记录。
- **只做 GUI**：用户长期使用 TUI，两个客户端必须共用后端契约并各自可进入 Chat。

## 验证与边界

所有自动化使用合成档案；用户真实完整 ZIP 仅在临时私有目录做离线烟测，没有上传模型或加入仓库。

- 真实档案最终复测：252 个选中的个人来源文件、101 个可检索来源；5 条可见说明（3 份已有编码问题与 2 项迁移范围说明）；上下文快照 17,825 字节 / 4 个来源。原 MEMORY 分页拼接与原文一致，指定日期记忆追加、重复导入不覆盖、重新创建服务后的冷读及限定来源检索均通过，隔离复测约 1.03 秒；这不代表 GUI 性能问题已经解决。
- 档案导入 / 读取 / 写入回归 12 项、实际工具权限回归 7 项、真实 HTTP 绑定 / 错误 / fork 回归 3 项、自动分享边界 1 项，全部通过。
- Session/TUI 定向回归：44 项通过；Chat agent 作用域 / 权限回归 3 项通过。
- CLI 使用独立临时 home / DB，三个真实进程验证 `companion import --json`、重新启动后 `companion list --json`、相同来源重复导入保护，全部通过。
- 实际 SessionPrompt → 本地 provider fixture 验证：旧 Soul 与记忆进入请求，工具搜索 / 保存走真实链路，新会话读到刚保存的记忆，Code 不携带个人档案。fixture 验证请求与持久化，不证明任何真实模型已表现出原有关系体验。
- 工具 Registry / Task / snapshot 回归：73 项通过。
- Instruction 默认路径与 Chat agent 作用域合计 44 项通过（含上列 3 项 Chat 作用域测试）。
- GUI 类型检查通过；模式、列表、会话导航、多语言、标题栏等 14 项定向测试通过。
- Core 类型检查通过：在 `packages/opencode` 使用仓库固定的 TypeScript 7，`GOMAXPROCS=2 GOMEMLIMIT=3GiB bun x tsc --noEmit --pretty false`。当前环境的普通包装脚本会转入 TS5 并遇到堆 / 进程内存限制；限制 Go 编译器并发后完成检查，未忽略诊断或改变代码类型约束。首次安装跳过 postinstall 导致的 keymap 双实例已通过仓库现有 `fix-keymap-junction.ts` 修复。
- SDK build、两份 OpenAPI 生成及漂移检查通过；HTTP 路由覆盖对账 188 场景，0 missing / 0 extra；新增 Companion HTTP effect 场景 3 项通过。版本一致性、注入登记、入口图预算、工具描述预算、控制字节、子进程超时与 diff 检查通过。无本机配置可用于 seed shadowing 比对，门禁按既有逻辑明确跳过。
- 新增 Playwright smoke，但本环境 Chromium 在建页面前因 `socket() failed: Operation not permitted` 终止。没有浏览器通过结果，也没有 Electron、Windows 安装包或真人格对话验收。
- 第一阶段没有后台心跳 / 梦境调度，没有原始历史会话重建，没有旧头像资产适配，没有跨机器自动同步。上述功能不能用「导入成功」替代验收。

## Windows 本地接入与复测（2026-11-17）

本节补充首批源码之后的本地验证，不覆盖或替代上节的历史记录。

- 本地 `master` 跟踪 `origin/master`，首批基线为 `f8958abc`。主要 CI 的 push / PR 基分支改为 `master`；没有变更权限、凭据或 action 来源。GitHub 默认分支和远端检查仍需在明确执行远端步骤后核实。
- 真实目录别名回归先失败、修复后通过：在 Companion 拥有边界解析真实目录，而非放松 Session 的个人工作区校验。Windows 完整档案首次落位出现一次 `EPERM`、原样重跑成功；档案目录落位与记忆索引提交两处统一复用 `AppFileSystem.renameWithRetry`，沿用现有错误码、平台与重试上限，不新增无限等待。策略来源见 `../bug-fix/2026-09-01-atomic-config-writes.md`。
- 本地完整目录离线导入：252 个文件 / 28,178,664 字节、101 个可检索来源、17,825 字节启动快照 / 4 个来源。逐文件核对原件、保存副本与 manifest 摘要；仅在隔离副本追加记忆，重复导入后仍可搜索和读取新增内容。原配置摘要不变，没有向模型发送真实档案。
- GUI 冷恢复回归用 Promise 门闩扣住列表与详情请求，旧实现的顶栏新建确实落到 Code 地址。修复后，绑定未就绪时顶栏和新建快捷键不可用；加载完成后仍指向原伙伴。另统一 `archived: 0` 的筛选语义，并修复 Chat 首页不存在的 `text-24-medium` 类，使用现有 20 / 16 字号层级。
- 本轮 core / TUI 定向 60 项、App 模式与会话命令 7 项、Chromium Chat 2 项通过；后续 Windows rename 接入后，档案 / 工具 / HTTP 23 项再次通过，已有原子替换原语 10 项通过。App 与 opencode 的包级类型检查通过。Chromium 长时间线切换和分页另 1 项通过，使用模拟服务，与下面的真实后端验证分开计数。
- 真实隔离后端 + Chromium：两个合成伙伴首次进入、发送、保存记忆、新建后召回、刷新恢复、切回原 Code 会话均通过。数据库中 `companion_memory` 搜索为 completed；伙伴 A 能找到刚保存的内容，伙伴 B 的结果不含该内容。请求元数据确认 Chat 只含对应伙伴资料及个人记忆工具，不含工程记忆；Code 仍绑定原 Soul、保留工程记忆且无个人记忆工具。
- 中文组合输入使用组合事件与真实 Enter：组合期间用户消息数不变；结束后消息恰好增加一条，内容正确、输入框清空。该测试不是原生操作系统 IME 验收。实际页面过程未收集到运行时错误。
- 编译版 TUI 通过真实 PTY 和终端仿真验证 `--companion`、发送、`/new` 保留绑定、`/code` 切换与独立身份、`/chat` 恢复、退出后指定伙伴续接及普通 `--continue` 只恢复 Code。不匹配的伙伴 / 会话在 stdin 正确关闭后明确退出 1；未把测试驱动器等待 stdin 的超时误报为 worker 泄漏。
- 本地 TUI 完整构建含 Web UI，`--version` 为 `0.19.0`。通过 `REDCODE_BUILD_DIR` 输出到隔离目录，未覆盖正在运行的旧版 exe。版本、OpenAPI 漂移、注入登记、控制字节、子进程超时与 diff 门禁通过。

完整 OpenClaw home 还包含模型、MCP、技能、渠道和调度配置。当前导入器不会把 `openclaw.json` 整包改写为 RedCode 配置：模型协议、工具替代关系、权限与路径需要单独映射；凭据不进入个人档案，旧渠道、心跳、梦境和定时任务不自动启动。原始 JSONL 会话和旧配置仍保留在原迁移源，不能将本节的个人档案接续称为整套旧运行时已经迁完。

本轮修复没有改提示词、注入装配顺序、工具 schema 或输出格式，没有新增固定前缀 token、缓存失效段或上下文来源；个人资料与工具的硬上限继续按本 note 的四问执行。Electron 壳、安装包与真实模型的关系体验不由上述浏览器和合成 provider 结果代证。

## 0.18.6 → 0.19.0 收编对账

上一版 bump 为 `f32668b`。对照 `git log f32668b..83e4c89`，原 Unreleased 内容整体纳入 0.19.0，原标记 0.18.7 的工作记录保留来源：

| 提交 | 已收编内容 |
| --- | --- |
| `d268c4f` | CI 三项修复、路由覆盖门禁 |
| `cef5dda` | 子任务补充要求、终端只读输出契约 |
| `dc51f79` | TUI 后台导航、终端查看、引导、结果阅读 |
| `74de738` | 工具真实详情、审查收尾汇总 |
| `ade7056` | GUI 引用定位、预览、输入与继续工作 |
| `5419a57` | 桌面 HTML 预览桥、真实更新状态 |
| `e6af301` | 原 0.18.7 路线图与实现决策 |
| `d225e74` | run 多步回合镜像回归 |
| `4a28b4b` | 每轮成果卡片 |
| `747c938` | 终端与回合边界复审修复 |
| `7bc9398` | 成果卡片遮挡、文件预览修复 |
| `83e4c89` | 成果卡片集成 |

本批没有重新声称这些历史工作已完成全部实机验收；其原有验收边界继续有效。统一包版本、双语 README 徽章与 CHANGELOG 为 0.19.0；仓库、CLI 命令和 `.redcode` 本机路径保持兼容。
