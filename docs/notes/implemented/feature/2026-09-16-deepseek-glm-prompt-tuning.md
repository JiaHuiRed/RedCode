# DeepSeek 与 GLM 提示词按 failure mode 收敛

状态:implemented

## 问题

DeepSeek V4.1 Flash 的主要风险是任务跑偏、顺手扩大范围，以及在错误根因上继续叠加局部补丁。GLM-5.3 Flash 在高推理档位下的主要风险是证据已经足够后仍重复调查、重新规划和验证，迟迟不行动。

两份提示词原本已有范围、根因和验证规则，但没有把这些模型特有的失效模式写成足够明确的停止条件。

## 决策

只调整现有的两份模型提示词，不新增 adapter 抽象，也不改变 `system.ts` 的模型路由：

- `deepseek.md` 将验证改为 meaningful checkpoint；验证失败时明确禁止对同一症状继续添加 workaround；相邻 bug、cleanup、refactor、optimization 和 style inconsistency 只有直接阻塞请求结果时才可修；窄而具体的调查直接用工具，只有真正宽泛或可并行的探索才委派 subagent。
- `glm.md` 将验证改为 meaningful checkpoint；根因使用与风险匹配的最低充分证据；有足够证据支持安全的局部动作时立即行动，除非出现新矛盾证据，不重开判断、重复调查、重读文件、重跑未改变的失败命令或重复规划。
- 两份文件保留既有 soul 让位条款和“描述问题不等于要求修复”的只读边界。Outcome Intent 不在本次改动中推断写入授权。
- GLM reasoning level 策略仍属于运行时配置，不写进模型提示词；独立 adapter 也暂不引入。

## 备选与否决理由

- **默认把“看看报错”推断为修复授权**:否决——会与全局 `AGENTS.md` 的模糊需求/只读边界冲突，提示词不能单独重定义写入授权。
- **为每个模型新增 adapter 文件**:否决——当前 `system.ts` 直接路由到单份 Markdown，新增抽象只为承载少量规则，收益不足以覆盖改动面。
- **把 GLM reasoning level 表写进 prompt**:否决——档位由 provider/配置层决定，模型提示词不能可靠改变运行时 effort。
- **每个微小编辑后都立即跑昂贵验证**:否决——改为逻辑完整改动后的最窄检查，保留仓库特定验证节奏与最终更宽验证。

## 后果

模型提示词是 `llm/request.ts:60-66` 拼接出的 system 第 0 段。`Token.estimate` 估算的静态变化为：

| 提示词 | 修改前 | 修改后 | 变化 |
|---|---:|---:|---:|
| `deepseek.md` | 2364 | 2479 | +115 |
| `glm.md` | 1666 | 1798 | +132 |

发布新版本后，每个受影响会话的首轮前缀需要重建一次；之后静态提示词稳定，不产生每轮抖动。没有新增无界的模型可见输入。

验证：`packages/opencode` 的 `bun run typecheck` 通过（tsgo 崩溃后脚本自动回退 TypeScript 5.9.3）；`bun test test/session/system-prompt-routing.test.ts --timeout 30000` 为 8 pass；`git diff --check` 通过。
