# skill 描述加上限：模型可见注入面预算审计的收口

状态:implemented

## 问题

260911 对「进入模型上下文的所有注入路径」做了一次预算审计（触发点是 AGENTS.md 四问之④：没有上限就是缺陷不是待办；本仓已两次栽在这条——`tool/read.ts` 图片分支曾无上限、`summary.diffs` 曾无上限写回消息行）。逐条核实后的现状：

| 注入路径 | 上限 | 位置 |
|---|---|---|
| 工具输出（全部工具，统一包装） | 2000 行 / 50KB，可经 `tool_output.*` 配置；双端 4:1 预览；全文落盘 + 7 天清理 | `tool/truncate.ts` + `tool/tool.ts` 的 `wrap` |
| shell 输出 | 同上（走 `trunc.limits()`） | `tool/shell.ts` |
| 压缩摘要中的工具输出 | 2000 字符，head/tail 80:20 | `session/compaction.ts` + `session/message-v2.ts` 的 `truncateToolOutput` |
| 子代理超时打捞 | 24000 字符，保留尾部 | `tool/task.ts` |
| MCP server instructions | 2000 字符 + 尾部标注 | `mcp/index.ts` 的 `capInstructions` |
| 项目指令（AGENTS.md / MEMORY.md / soul） | 64KB **告警不截断**（有意，见下） | `session/instruction.ts` |
| patch / diffs | 会话级 + 单轮级 `capPatches` | `session/summary.ts` |
| 图片 / PDF | 文件 32MB 上限 | `tool/read.ts` |
| hash mismatch 报错 | 50KB | `tool/edit.ts` |
| **skill description** | **无 —— 本次补上** | `skill/index.ts` 的 `fmt` |

唯一无界项是 skill 的 `description`：来源是用户或第三方 SKILL.md 的 frontmatter（`skill/index.ts` 加载时原样入库，无任何校验），却随 `<available_skills>` 每轮全量注入系统提示词——固定前缀，最贵的位置。一个写长篇描述的 skill 会永久抬高每轮输入，且从会话里完全看不出来。

## 决策

`skill/index.ts` 新增 `MAX_DESCRIPTION_CHARS = 1024`，`fmt()` 的 verbose 块与工具描述列表两处统一经 `capDescription()`：超限从尾部截断，追加 `[...truncated N chars]` 标注。与 `mcp/index.ts` 的 `capInstructions` 同一纪律——**截断必须标注，别让模型以为自己看到的是全部**。

取值 1024 对齐 Pi 的 `MAX_DESCRIPTION_LENGTH`（`packages/agent/src/harness/skills.ts`，本次 harness 调研的直接参照）。本机 24 个 skill 实测最长 118 字符、描述总长 397 字符；seed 12 个最长 118。8 倍余量。

## 备选与否决理由

- **加载时校验、超限拒绝加载（Pi 的做法）**：否决——`description` 超长没有正确性含义（它只是路由提示），而拒绝加载会让 skill 静默消失，比截断更伤；且本仓现无校验机制，新加校验是行为变更、会打断已存在的长描述 skill。
- **不截断、只告警（`instruction.ts` 的既有做法）**：否决——那条的设计理由对 AGENTS.md/MEMORY.md 成立（截断会丢铁律，代价高于前缀膨胀），但 skill 描述是路由提示、截断不丢纪律；且 skill 数量与描述来自第三方，比项目指令更不可控。
- **上限取 2000 对齐 MCP instructions**：否决——1024 已有 8 倍余量，且对齐 Pi 便于两边对照；2000 只会让防线更松。
- **同时限制 skill name**：否决——name 是模型调用 skill 的键，截断会破坏调用；且 name 由目录名派生，实际长度受限，不值得引入。

## 后果

- 现有会话前缀逐字节不变（未触发截断即为恒等变换），无 KV cache 影响、无 token 增量；上限只约束未来。
- 被截断的描述会在 `<available_skills>` 里以 `[...truncated N chars]` 结尾——若未来有 skill 撞线，这是识别签名：模型路由准确率下降时，先查这里。
- 审计表（本 note 上方）是本次的完整产出：**其余注入路径均有硬边界，无需重复审计**。日后新增注入路径时，对照此表检查是否缺上限，并把新路径补进表内。
- 测试：`packages/opencode/test/skill/skill.test.ts` 新增 3 条（verbose 截断+标注、plain 列表截断、短描述逐字节不变）。
