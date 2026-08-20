# 上下文真实构成查看器

状态:implemented

## 背景

哥哥问「还有没有类似 tokens/s 这种——代码里已经有、前端一直没显示的东西」。清单里排第二的是
`/api/session/:sessionID/context`：服务端实现了、OpenAPI 发布了、SDK 生成了
`client.v2.session.context()`，全仓零调用方。看起来是纯前端接一下就完事。

**不是。那个端点是空的。** 它读 `session_message` 表，而该表的会话内容写入在 688c31cf（摘除会话
事件系统双写）之后就停了——`prompt.ts` 现在只 publish `AgentSwitched` / `ModelSwitched` 两种事件。
拷 live 库查过：782 行里只有 `model-switched` 501 + `agent-switched` 281，**一条对话内容都没有**；
真正的会话在旧 `message` 表（51,264 行）。

所以这次不是「接一下」，是换源头重做。

## 决策

### 1. 在请求发出的那一刻记账，不在读取时重建

候选源头有三个：

| 源头 | 问题 |
| --- | --- |
| `session_message` 表 | 空的（见上） |
| `PromptCaches` | 缓存的是 system 的**原料**（env/instructions/skills），不是最终数组 |
| 发出前的那几个变量 | ✅ |

`PromptCaches.system` 只存 env/instructions/skills 三份原料；`runLoop` 每轮还要往 `system` 上追加
日期、WORK RULES、按模型家族分支的若干锚（step/flash 各一套）、canary、DCP 说明。拿原料拼一遍
等于把 runLoop 的拼装逻辑在读取侧复刻一份——加一条锚漏一处、数字就悄悄偏，而且偏了没人发现。

改成在 `handle.process` 之前记 `ContextSnapshot.record({ system, tools, messages })`，三份都取
**实际传进去的那几个值**。顺带把 `messages` 从参数位提成 `outgoing` 变量：留在参数位上就只能记
`stabilizedMsgs`，差的正是每轮变动的那三条临时注入（user reminder / loop recovery / MAX_STEPS）。

### 2. 只留最后一轮、只在内存

这是「**现在**窗口里装的是什么」，不是历史指标。落库要为每轮写一条几百字节的记录，换来的是没人
会看的历史。重启后本会话下一轮请求就重新有值，代价可接受。回收接 `session-evictor`（与
prompt-caches / prefix-shape 同一套），不再新增一处无界 Map。

没有快照时 HTTP 返 **404 而不是空对象**——空对象会被 UI 画成「构成全是 0」，那是在说谎。

### 3. 稳态成本靠对象引用记忆，不是靠开关

`system` 段只做 `length / 4`，免费。`tools` 每轮按工具序列化一次（`PrefixShape.capture` 本就整体
序列化一次，这里是同一批数据换成逐个）。真正的大头是 `messages`——全量 `JSON.stringify` 是一次
完整上下文的开销。

不给它加开关，改成 `WeakMap` 按**对象引用**记忆：`modelMsgs` 的前缀是钉死的同一批对象
（`stabilizedMsgs` 直接展开缓存数组），所以稳态下只算新增的那几条。只有 compact 结算后重新钉的
那一轮会全量算一次。

### 4. 端点不叫 `/context`

叫 `/session/:sessionID/context-inspect`。v2 那边已经有个 `/api/session/:id/context`，撞名只会让人
以为是同一个东西的两个版本，而它现在是个空壳。

## 后果

- 新端点 `GET /session/:sessionID/context-inspect` → `ContextSnapshot`：system / tools / messages
  三块各自的 token 数与明细（system 按段、tools 按最贵的 8 个、messages 按角色），外加 total。
- GUI 上下文面板新增「真实构成」一段，在既有「上下文拆分」之上。两者的区别不是精度是**范围**：
  估算器手里从来没有 system 与 tool schema 这两份数据，而它们恰恰是前缀里最大且最不透明的部分。
- 测试：`context-snapshot.test.ts` 13 例（label 归一化、三块计数、降序与截断、角色归并、非字符串
  content、按会话隔离、覆盖语义、引用记忆、空输入）；httpapi-exercise 新增 `session.contextInspect`
  场景（同进程种一条快照覆盖 200 分支，否则新建会话必然 404、成功 schema 永不被走到）。
- `prompt.test.ts` 7 fail 全是既有的超时类失败——同一命令在还原 `prompt.ts` 的基线上跑出完全相同的
  7 fail / 32 pass，零新增。
- 未做：TUI 侧。侧边栏只有 42 列，装不下三块明细；合适的形态是个 `/context` 对话框（参照
  `dialog-status.tsx`），留作后续。
- 未做：`/api/session/:id/context` 那个空壳端点没动。它的去留是独立决定——要么让它读旧 `message`
  表重建，要么删掉，都不该混在这次里。
