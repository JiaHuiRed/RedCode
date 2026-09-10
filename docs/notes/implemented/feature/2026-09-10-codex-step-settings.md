# 每个模型 step 冻结当时的会话设置

状态:implemented

## 问题

`SessionPrompt.runLoop` 之前在一轮开始时读取一次 `Session.Info`，后续多个模型 step 继续复用它。模型和 agent 已经按 step 解析，但 `session.permission` 仍是旧快照：如果第一步工具执行期间更新了会话权限，第二步的工具解析和 `handle.process` 仍会使用旧权限。回归测试在旧实现上实际执行了两次本应只执行一次的 `read` 工具。

## 决策

每个 step 在拿到当前 `lastUser` 后，固定一份 `{ user, session, model, agent }` 设置快照。该快照统一供标题生成、子任务、压缩、提醒、assistant 元数据、processor、工具解析、上下文快照和模型请求使用；普通路径仍在消费快照时检查 agent 是否存在，子任务路径不因父 agent 缺失而提前改变原有行为。

## 备选与否决理由

- **每个下游调用各自重新读取设置**：否决——同一个 step 内可能出现 session、agent、model 不一致，正好破坏要解决的边界。
- **继续使用 turn 开始时的 session**：否决——权限更新无法传播到后续 step，旧回归已经复现。
- **把 model 放进 provider cache key 来解决首个 cache miss**：否决——那是 provider KV cache 的命名问题，不是 step 设置串用；新模型首请求 0 命中仍可能是正常冷启动。

## 后果

- 每个 step 多一次 session 读取和 agent/model 解析，换来 prompt、工具 schema、权限审批与执行使用同一版本。
- 本决策不改变 provider 端 `promptCacheKey`，不承诺不同模型共享 KV cache，也不保证切换后的第一次请求命中；切回旧模型仍持续 0 命中时，继续检查 modelKey、provider cache key、工具 schema 和 prefix shape。
