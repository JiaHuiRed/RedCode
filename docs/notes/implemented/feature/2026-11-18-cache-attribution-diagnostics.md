# 用服务端字段归因定位缓存缺口

状态为 implemented。

## 问题

`gpt-6.2-sol` 在 Codex OAuth 端点上每轮出现约 22k 固定未命中。本地 `prefix-shape` 能证明 system 与 tools 没有变化，却回答不了"服务端把哪一段算作未命中"。Codex issue #62109 的原始响应给出了字段级答案：`usage.attribution.request_fields.instructions` 分别报 `input_tokens`、`cached_tokens`、`cache_write_tokens`，同一请求里用户历史可以命中而顶层指令报 0。

## 决策

在 `request-evidence` 的原始 usage 白名单里加三项指令归因（`input_tokens`、`cached_tokens`、`cache_write_tokens`），白名单字段数上界从 9 变为 12，并派生三个数值：

- 本轮未从缓存读取的输入 = `input_tokens − input_tokens_details.cached_tokens`
- 顶层指令未命中 = 指令 `input_tokens − cached_tokens`（两个字段都存在时才算）
- 尚未归因的输入 = 未读缓存 − 指令未命中

任一输入缺失时对应键不出现（「未知」），显式 0 保留为 0；剩余差额只报「未归因」，不自动记在工具名下。两条运行时共用同一套投影：AI SDK 路径读 `finish.usage.raw`，native 路径读 `Usage.providerMetadata.openai`。为 native 在 `OpenAIResponsesUsage` 里声明 `attribution` 与 `cache_write_tokens` 到叶子，否则 `Schema.Struct` 会丢弃未声明字段。只保留数值，不保留提示词或对话原文。

## 备选与否决理由

- **只加 AI SDK 路径**：否决——native 对 OpenAI API-key 模型同样在跑，两套诊断口径不一致会让以后对比困难。实现成本只是 schema 叶子声明加复用同一个派生函数。
- **把剩余差额按工具表本地估算补齐**：否决——本地估算是估算，服务端归因是实测，混在一起后无法区分"测出来的"和"猜出来的"。
- **缺失时按 0 处理**：否决——`cached_tokens ?? 0` 正是 AI SDK 归一化丢信息的原坑；缺失与显式 0 必须分开。

## 后果

诊断只在 finish 之后读取数值并写日志，不改变请求形状、固定前缀、缓存行为，也不新增模型上下文。日志字段仍是白名单数值（上界 12 项）加三个派生数值，不含原文。若端点整体不返回 `attribution`，诊断显示「未知」而不是 0——这说明端点没提供归因，不是我们丢了字段。

## 回家验证步骤（2026-11-18 已完成）

> 结论已回填，见本节末尾「实测结果」。以下步骤保留为复现方法。

1. 打开 RedCode，选 `gpt-6.2-sol`（OAuth），发一条会走至少一轮工具调用的消息；能连续两轮更好。
2. 日志目录 `%USERPROFILE%\.redcode\data\log\`，按文件名时间戳找当次会话对应的 `<时间戳>.log`。注意每次重启会换文件。
3. 搜索 `request.provider-usage`。每轮 finish 一条，确认行内 `runtime=ai-sdk`（6.2 Sol OAuth 不会走 native）。
4. 读该行的四个位置：
   - `cachedTokens`：`reported` / `reported-zero` / `missing`
   - `uncachedInputTokens`：本轮未读缓存
   - `instructions={"inputTokens":…,"cachedTokens":…,"missTokens":…}`：顶层指令归因
   - `unattributedInputTokens`：尚未归因的剩余
5. 判读：

| 看到的现象 | 结论 | 下一步 |
| --- | --- | --- |
| 没有 `instructions=` | 端点这次响应没返回字段归因 | 保持「原因未定」；不要据此讨论迁移指令 |
| `cachedTokens=missing` | 连基础缓存字段都没报 | 先查端点/响应形状，派生值不可信 |
| `instructions.missTokens` 接近 22k | 顶层指令是缺口主体 | 才轮到评估迁移指令（见增量工具声明提案的第三项）；迁移前必须做同请求 A/B，issue #62109 已记录 developer 消息变体未改善 reuse |
| `instructions` 只有几千，`unattributedInputTokens` 仍很大 | 大头在工具表或新增历史 | 转向增量工具声明或其他方向 |
| 连续两轮 `uncachedInputTokens` 都约 22k、`instructions.missTokens` 恒等于指令总量 | 固定块每轮全丢 | 与 issue #62109 的观察同类，按上一条处理 |

6. 如果确认了指令归因，把两轮日志行原样保存（数值即可，不需要提示词），作为后续 A/B 的对照基线。

### 实测结果（2026-11-18）

在 `2b02a501` 上用 `redcode run` 各开独立标题会话，`variant=low`，只回复 `OK`，无工具调用：

- `gpt-6.2-sol`：第二轮 `cachedTokens=reported`、`cached=12,800`，`instructions.missTokens=21,741`（全未命中），
  `unattributedInputTokens=1,285`。
- `gpt-6.2-astra`：第二轮 `cachedTokens=reported-zero`、`cached=0`，`instructions.missTokens=21,740`（全未命中），
  `unattributedInputTokens=14,087`。

判定落在第 5 步表格的「连续两轮 `uncachedInputTokens` 约 22k、`instructions.missTokens` 恒等于指令总量」一行：
顶层指令是缺口主体。两轮之间 `system`/`tools` 段哈希未变，说明不是本地装配漂移。样本仅两轮，不能推断长期行为。
完整数值表见增量工具声明提案的「字段归因实测」节。

## 相关

- 增量工具声明提案：`docs/notes/proposed/feature/2026-11-18-incremental-tool-declarations.md`
- 上游证据：openai/codex#62109（字段样本与反证）、#51156（指令迁移实现）、#62071（前缀回归测试）
