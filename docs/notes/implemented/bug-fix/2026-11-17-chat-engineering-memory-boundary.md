# Chat 做事时仍属于伙伴，工程记忆只进入 Code

状态:implemented

## 问题

首批 Chat 已排除根会话的工程 MEMORY，但还有三条明确路径越过这个边界：InstanceBootstrap 把伙伴目录当普通项目生成 `.redcode/MEMORY.md` 和工程文档模板；外置工程记忆插件的 system / messages transform 不知道会话模式；Chat 子任务只因不是个人主会话而重新加载工程 MEMORY。共享工具不应顺便改变记忆归属。

## 决策

- 通过已注册 Companion profile 识别个人工作区，跳过工程记忆脚手架。普通 Code 工作区仍生成原来的 `.redcode` 文件；已有文件和配置不删除，产品改名也不迁移兼容路径。
- 核心工程 MEMORY 与维护条款按 `session.mode` 排除整个 Chat 家族；个人资料及记忆工具仍只给 Chat 主会话，子任务不额外获得私人历史。
- Plugin SDK 增加可选 `promptModes`，只限制两种 prompt transform。引擎根据持久化 Session 绑定提供 `mode / companionID / parentID`，不信任调用方传入的模式。未声明的插件保持两种模式可用，旧的无会话调用按 Code；tool / auth / config 等钩子不受此字段影响。
- 同步适配私有配置中的工程召回与 CORE 注入插件，只向 Code 注入；私有全局指令也明确工程记忆流程只约束 Code。必须安装对应私有配置更新，单独升级引擎不会猜测任意插件的用途。
- Chat 基础提示明确：外部目录中的实际任务和共享技能不改变个人记忆归属。日期日记仍在 `~/.redcode/companions/<id>/workspace/memory/YYYY-MM-DD.md`，旧资料及聊天原文按需查询，不把全部历史装进当前会话。

## 备选与否决理由

- 关闭 Chat 所有插件、MCP 或技能：会丢失用户需要的实际办事能力。共享全局配置和普通技能，单独约束工程记忆注入即可。
- 靠插件文件名识别 memory：名称不是行为契约，使用插件声明和明确适配。
- 删除旧伙伴 `.redcode`：可能包含用户配置，且隔离注入无需破坏文件。
- 按当前工具 cwd 切换记忆：会让一次外部目录操作改变伙伴归属；身份以会话绑定为准。

## 后果

这不是任意第三方插件或文件工具的沙箱。全局 AGENTS、权限与工具仍有效；其他记忆插件需要自行声明适用模式。MCP / 全局普通技能共享，项目本地配置仍按当前实例目录发现，不因 shell 切换目录自动加载另一项目的技能。没有改变 Code 的 Soul、工程数据库或既有跨项目能力；本次不引入新的 Work 模式或记忆数据库。

## 验证

- InstanceBootstrap 真实导入伙伴，加载 / 重载均不生成工程模板，日期日记可写；普通工作区用例继续生成工程模板。
- 插件触发测试读取真实 Session 绑定，调用方伪造模式无效；Code 的注入保留，工具定义仍共享。
- SessionPrompt 合成 provider 捕获实际 HTTP 请求：Chat 主会话 / 子任务都不含工程 MEMORY 和两个插件哨兵；普通技能仍可见；Code 保留自己的 Soul、工程记忆与插件。换 Chat 会话能读取日记并查询上一会话未入日记的原话；连续工具轮次的 system 和 tools 前缀保持一致。
- 私有召回插件使用隔离 SQLite 数据库，在 Node / Bun 下验证 Chat 不查询 / 不写召回审计、Code 仍召回；原有预算与来源用例继续通过。Bun 测试使用独立临时模块文件，避免忽略 URL 查询参数造成模块缓存串用。
- 核心与 Plugin SDK 类型检查通过。上述证明装配与持久化边界，不代表真实模型长期人格体验或 Windows GUI 性能验收。

## 模型可见四问

1. **内容**：Chat 原有「Keep private memories in this companion's archive rather than project or global engineering MEMORY files.」后新增固定段，以「Doing practical work in another directory or loading a shared skill does not change this memory ownership.」起头，明确实际工作与技能不会重定向个人日记。Chat 子任务删除工程 MEMORY 及维护条款；适配后的插件不再给 Chat 注入工程召回。私有全局指令新增 Code 专属范围说明。工具 schema 不变。
2. **Token**：沿 `prefix-shape.ts` 的 `Token.estimateReporting` 口径，Chat 固定文件从 229 到 316 tokens，净增 87，全文 1,262 bytes。公共引擎的 Code 固定前缀不变。私有指令新增范围段约 68 tokens，另加短标签，安装后两种模式均可见。以上为仓库字符估算，非 provider tokenizer；被移除的工程注入量随用户配置而变。
3. **KV cache**：升级后 Chat 从 agent 基础提示起一次性重建前缀；安装私有指令更新后 Code 从全局 instructions 段起一次性重建。插件模式元数据不进入模型正文。会话期间没有逐轮重写个人快照，没有新增 LLM 调用。
4. **硬上限**：新增提示是上述固定大小；既有个人快照总计 32 KiB、search 输出 8 KiB / 10 条、read 原文 16 KiB、remember 单次 8 KiB 的上限保持。本次无新增可增长注入源。个人快照可超过 1K token，原因与分项限额沿用伙伴架构 note；旧聊天仍按需有界检索。

关联：[伙伴 Chat 架构](../architecture/2026-11-17-redspace-companion-chat.md)、[聊天原文召回](../feature/2026-11-17-companion-session-recall.md)。
