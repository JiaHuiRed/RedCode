# Chat 只加载伙伴自己的一份 AGENTS

状态:implemented

## 问题

Chat 主会话此前走与 Code 相同的 instruction 发现链：全局 `~/.redcode/AGENTS.md` 与项目级 AGENTS 一起注入，`instruction.system({ memory: false })` 只挡掉工程 MEMORY，没挡 AGENTS。本机实测 Chat system 约 9-10K token，其中全局工程 AGENTS 占约 2.1K，加上伙伴自己的档案也只有四成是 Soul 与 memory。

这与 Chat 的产品定位相反：伙伴是主陪伴、轻干活，工程规则（commit scope、验证命令、子进程超时、notes 回链）对她是无效负担，还挤占 Soul 和记忆的位置。Code 继续需要全局 + 项目两份 AGENTS，两条路径的目标不同。

另一个事实：Chat 会话被 `session.ts` 的 `Open Chat in the companion's personal workspace` 锁在伙伴 workspace，项目级 AGENTS 为空。真正在吃的是全局那份，属于「用户不需要、模型也不用」的纯前缀成本。

## 决策

- Chat 主会话不再注入任何 `kind === "agents"` 的来源（全局、项目一并跳过），工程 MEMORY 原本就已跳过。
- 只注入唯一一份 `packages/redspace/src/session/prompt/companion-agents.md`：家是 workspace、醒来先用启动上下文、日记与 MEMORY 的写法、陪伴分寸、轻干活与交接、安全边界。
- 支持用户覆盖 `~/.redcode/companion-agents.md`：`stat` 预检大小，非空且 ≤16 KiB 时用它，否则回退内置并写 `log.warn`。覆盖仍是同一份，不与任何 AGENTS 叠加。
- Code 路径不动：`agents` 默认为 true，`instruction.system()` 的行为与原来逐字节一致。
- `chat.md` 删除与伙伴 AGENTS 重叠的陪伴/日记段落，只保留 Chat 模式契约（身份来源、个人上下文有界、证据类型、记忆归属、跨目录不改变归属）。

实现点：`instruction.ts` 的 `evaluate` 新增 `agents` 过滤；`prompt.ts` 在 `personalChat` 时于 `env` 之后注入 `companionAgents`；登记表 `docs/injection-registry.jsonc` 增加 `companion-agents` 一行。

## 备选与否决理由

- **保留全局 AGENTS**：否决——Chat 与她聊生活时也在为工程红线付费，且实测占前缀三成。
- **给 Chat 接完整模型家族提示词**：否决——`default.md` 那套是工程执行基线，会把人压成半个 Code agent；Chat 不需要验证/交付/类型检查的肌肉记忆。
- **两份叠加（伙伴 AGENTS + 全局/项目）**：否决——违背「有且只有一份」，且无法解释哪条覆盖哪条。
- **允许 Chat 从项目目录打开**：否决——`session.ts` 的 workspace 锁是人格与工程边界的一部分，放开等于让 Chat 进入 Code 的地盘。
- **把伙伴 AGENTS 做成伙伴可编辑的 workspace 文件**：当前否决——她不需要改家规；用户手动改走 `~/.redcode/companion-agents.md` 覆盖，保持引擎默认可跟随版本演进。

## 后果

- Chat 固定前缀净减约 1.7K token（本机：移除约 2.1K、新增约 0.4K），Soul + memory 的占比升到一半以上。
- 仅 Chat 主会话前缀从 env 后一段起作废一次；Code 与子任务逐字节不变。
- 覆盖文件改动在下一轮请求生效；内容不变时前缀字节稳定。
- 内置文件与覆盖文件都有 16 KiB 上限，超限回退并告警——这是注入面「没有上限就是缺陷」的落实。
- 验证：redspace typecheck 通过；`instruction.test.ts` 42 pass（含新增 `agents:false` 同时挡掉 AGENTS/MEMORY 用例）；注入登记表自检 40 项有效。
