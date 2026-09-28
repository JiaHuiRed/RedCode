# Edit 补丁在 PartTable 中只持久化一次

状态:implemented

## 问题

`edit` 工具把同一个 unified patch 同时放进 `metadata.diff` 与
`metadata.filediff.patch`。TUI/CLI 消费前者，Web 消费后者，两个字段都属于公开
part 契约；`PartTable.data` 又会把整个 part 序列化，因此每次编辑会把同一份大 patch
落库两遍。

## 决策

- 写入 `PartTable` 前，`MessageV2.toStoredPart()` 仅在 `tool === "edit"` 且两个 patch
  字段完全相同时，省略存储副本 `filediff.patch`，并写入内部标记以说明这是存储适配器省略的。
- 读取 `PartTable` 时 `MessageV2.fromStoredPart()` 只对带有该标记的紧凑行从 `diff` 恢复
  `filediff.patch`，随后移除标记。`MessageV2.part()` 覆盖 hydrate、parts 与 recentToolParts；
  `Session.getPart()` 的直接读取也走相同恢复函数。
- 若两字段不同，或旧行已经同时含有两个字段，则不改写其值。无标记的旧行即使缺少
  `filediff.patch` 也保持原状；外部 part/API 形状不变。
- 只变更默认 `PartTable` 投影，不做 schema migration 或历史行回填。实验性 workspace
  EventTable 仍保存原始事件 payload，以保持可回放事件的数据形状；该功能默认关闭。

## 备选与否决理由

- **删除 `metadata.diff` 或 `metadata.filediff.patch`**：否决——会破坏分别依赖它们的
  TUI/CLI 与 Web 消费方。
- **在工具输出处删掉一个字段**：否决——实时 PartUpdated 事件同样需要完整的公开契约。
- **迁移数据库列或重写历史记录**：否决——`PartTable.data` 是 JSON，读适配可兼容新旧行，
  无需迁移。

## 后果

- 新写入的 edit part 在默认 PartTable 中只保留一份相同 patch；内部标记被读取适配器剥离，
  API 仍返回原有双字段，旧行无需更新。
- 任何绕过 `MessageV2.part()` / `Session.getPart()` 的底层 PartTable 读取者只会看到紧凑存储
  形状，应继续复用统一 adapter。
- `experimentalWorkspaces=true` 时 EventTable 仍包含原始双字段；此优化不改变事件日志。
- 纯 adapter 测试验证 JSON 中只出现一份 patch、紧凑行会恢复两个字段、无标记旧行不会合成
  缺失 patch；真实 Session/SQLite 集成测试验证 `Session.getPart()`、`MessageV2.parts()`、
  `MessageV2.page()` 都保留公开字段契约。

## 回链

- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/projectors.ts`
- `packages/opencode/src/session/session.ts`
