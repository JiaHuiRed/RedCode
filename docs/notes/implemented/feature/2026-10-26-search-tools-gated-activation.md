# search_tools gated 工具模型侧激活（dsh-ops discovery 的最小等价）

状态:implemented

## 问题

`GATED_TOOLS`（`tool/registry.ts`）把零调用低频工具默认从模型工具表剔除，省固定前缀 token；但恢复只有一条路——用户改配置 `provider.<id>.models.<id>.tools.<id>=true`。模型在会话中无法自助：常驻的 `search_tools` 能搜到 gated 工具的名字，却调不了，只会诱导模型走弯路。

外部参照：dsh-ops（`E:\AI\dsh-ops`，DeepSeek Harness 插件）的 discovery 组件用 `ops_discover_tools` 做渐进式工具披露——常驻只留 read/discover 两个入口（242 tokens），15 个高级工具 schema 按需激活、下一供应商请求生效。其宿主 API（`ctx.tools.register`、pre-step 提示重组）与 RedCode 的 Effect registry 不同，整包不可移植。

## 决策

**不加新工具，给常驻 `search_tools` 补激活出口**：

- `search_tools` 新增可选参数 `enable`：值必须是 `GATED_TOOLS` 成员且在 `all()` 中注册。命中后仍返回单行确认，metadata 仍为 `{ enable, activated: true }`；`tools()` 的 gated 剔除分支只对当前会话的激活集合放行。
- 搜索结果的 gated 未激活工具追加 `[gated — call again with {"enable": "<id>"} to activate]` 标注，模型一次搜索即可发现激活路径。
- 优先级不变：配置 explicit 布尔（`modelTools`）先于激活集合判定；`Permission.disabled` 的 deny 剔除先于两者——激活不能越权。
- `tools()` 接受显式可选 `sessionID`。会话工具构造传当前会话 ID；未传的预览式调用使用空激活集合，gated 工具保持隐藏。
- 激活缓存按 `sessionID` 分桶，实例内懒加载：首次构造该会话工具表时，从 `part` 读取 completed 的 `search_tools` 工具分片，其中 `state.metadata.activated = true`，并把对应 `state.metadata.enable` 还原为 gated 工具 ID。缓存为 `Map<SessionID, { loaded, tools }>`；successful enable 在当前会话分桶写入，若尚未加载，则首次查询会把持久记录合并进来。
- 事实来源是 `part` 表，不是 `SessionTools.resolve` 的 `input.messages`（其内容可能已经压缩）。压缩保留 part 行；fork 复制消息与 part，因此父会话历史激活可由子会话自然继承。

## 备选与否决

- **独立 `discover_tools` 工具**：否决——与 `search_tools` 职责重叠，多占一份常驻 schema token。
- **插件实现**：否决——RedCode 插件 `tool.definition` hook 只能改 description/parameters，不能增删工具表成员；渐进披露必须动 registry。
- **从请求内存消息恢复**：否决——`SessionTools.resolve` 输入可能已压缩，不能作为持久激活事实来源。
- **revert 时主动失效、TTL 或后台清理**：不做——激活只放宽工具可见性，权限 deny 与配置显式 `false` 仍优先；revert 后缓存最多继续显示一个可用工具，不形成越权。会话删除后只遗留该实例缓存中的少量字符串，不引入额外清理机制。

## 后果

- 模型可见四问：
  1. `search_tools` description 追加激活语义一句、参数表新增 `enable` 字段、gated 结果追加标注一行；GATED 工具默认仍不可见，激活后下一请求出现。
  2. 固定前缀增量约 40–60 token（description 一句 + enable schema）；GATED 工具平时仍 0。
  3. 新会话前缀从工具表段起变化；已缓存会话不热替换。激活动作使下一请求前缀从工具表段失效一次——这正是「买进 schema」的功能语义。
  4. `search_tools` 输出有界（全工具 id 列表 / 120 字符截断摘要 / enable 单行确认），无新增无界注入。
- 本次会话化对首批行为的变化：
  1. 不改 prompt、`search_tools` description/参数/输出或工具 schema；一个会话的激活只会让该会话工具表包含对应工具，其他会话不再共享。
  2. 静态前缀零变化；会话工具表的既有 GATED schema 只出现在本会话已激活后，仍计入该请求正常的工具表预算。
  3. 工具表前缀仅在本会话激活生效的下一请求变化；别的会话前缀不受影响。重启后从 part 在构造首个工具表时恢复，不额外做热替换。
  4. 无新增模型注入项；恢复的是既有 GATED 工具 schema，不把 part 内容注入上下文。
- 已知边界：`external-directory`、`lsp` 等成员在部分 flag 组合下不注册，搜索自然搜不到；激活只对在册工具生效。
- session 缓存以 registry 实例为作用域，键为完整 `sessionID`。第一次 `tools({ sessionID })` 查询时加载，随后仅由成功 `search_tools enable` 增补；不在 revert、TTL 或删除会话时失效。未传 sessionID 不读缓存也不查库。

## 验证

`test/tool/registry.test.ts` 覆盖会话隔离、持久 part 懒恢复、`activated: false` 不恢复、无 sessionID 隐藏、显式关闭与 permission deny 优先，以及原有搜索/拒绝路径。`bun run test test/tool/registry.test.ts --timeout 30000`：39 pass / 0 fail。`bun run typecheck`：tsgo 崩溃后自动回退 TypeScript 5.9.3，零错误。

恢复查询只投影 `json_extract(data, '$.state.metadata.enable')`，条件为 `session_id = ?`、`$.type = 'tool'`、`$.tool = 'search_tools'`、`$.state.status = 'completed'`、`$.state.metadata.activated = 1`；只将仍在 `GATED_TOOLS` 中的 ID 缓存。无表结构变化、无 migration。

回链：`tool/registry.ts` 的 `GATED_TOOLS` 与 session activation 注释（261026 Red）。
