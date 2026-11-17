# Chat 从同一伙伴的持久会话召回原话

状态：implemented

## 问题与决策

个人日记是精选内容；没有进入日记的原话仍由 Session 持久化，但此前 `session_query` 默认排除当前会话，并允许按工程目录扩大范围。Chat 需要在压缩后、新会话中查询同一伙伴的经历，不能把不同伙伴、Code 或子任务的内容混成个人记忆。

复用 `session_query` 的有界数据库读取，不另建全文索引，不复制每轮聊天到日记。工具执行时读取调用会话的持久绑定：Chat 强制限定 `mode=chat`、相同 `companion_id`、根会话，包含当前会话；目录、会话 ID、part ID 和游标均不能绕过范围。Chat 子任务拒绝访问。只返回原始 text，排除 ignored、synthetic、压缩摘要及所有工具结果，保留角色、时间和原文 ID。Code 的工程查询行为不变。

使用既有 `session_query` 权限键，Chat 的范围为 `companion:<id>`。`companion_memory` 描述补充：日记缺少细节且有 `session_query` 时，检索短语并回读原文；空页带游标时继续查，不能以一页未命中推断用户没说过。既有 `read`、精选 `remember` 与保存权限不变。

RedClaw 的参考机制是 `memory_search` → `memory_get` 和 `sessions_history`，参考版本 `49ccafcabfce4252eec93f6c67b2950cab096ede`；本实现复用 RedSpace 正典库，没有复制其独立索引或运行时。

## 验证与限制

- 定向查询测试 8 项通过：原有 Code 行为、分页、中文字面搜索、预算、权限与取消；新增同伴作用域覆盖当前/旧会话、跨身份/Code/子任务拒绝、摘要/注入/回显排除、角色归属及空页续查。
- 实际 SessionPrompt → provider fixture 1 项通过：用户谈到的细节没有写入日记，也不在新 Chat 的启动快照中，经工具查询后原话进入下一次请求；期间 system 和工具表不变，Code 不携带该细节。
- 包级 typecheck 通过。合成 provider 验证请求链路，不是对真实模型永不遗忘、人格不漂移的承诺。
- 沿用原查询预算：每页最多扫描 1000 个 part，结果默认 8 KiB / 2048 估算 token，硬顶 16 KiB / 4096；多页低命中查询需要继续检索，底层 SQL 元数据排序没有固定时延保证。
- 本提交解决 RedSpace 已持久化聊天的召回；旧 OpenClaw JSONL 的语义导入另行实现。

## 模型可见四问

1. **内容**：`session_query` 描述由“other sessions in cwd”补充为 Chat 固定同伴范围、包含当前会话且仅原始对话；`companion_memory` 增加日记之外的聊天召回说明。工具 schema、system、原始消息和结果结构不变。
2. **token**：描述分别由 492 → 674 字节、1569 → 2063 字节，按仓库 `Token.estimate` 增加约 45 / 124 token；Chat 合计约 169，Code 约 45。没有逐轮新增固定前缀或额外模型调用。
3. **KV cache**：发布后的工具描述段一次性变化；之后同一会话的工具表和 system 保持稳定。命中原文只作为本次工具结果进入历史。
4. **硬上限**：声明是固定源码；输入沿既有 schema 限额，结果沿原查询字节/token/扫描上限。游标绑定同伴 ID 与筛选条件，不引入整库注入。
