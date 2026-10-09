# 会话短期变更日志与重连补拉

## 问题

SQLite 投影已经与事件序号同事务提交，但普通 GUI 的 SSE 只广播当前事件。连接中断期间提交的消息、删除和费用变化不会自动重放。

已有 `event` 表只在 experimentalWorkspaces 开启时保存完整事件，工作区同步依赖其中的完整载荷。不能为了 GUI 补拉把该表默认开启：逐次保存增长中的正文、工具结果和附件会重复放大数据库。

另一个断点是会话页订阅了目录级 emitter，却等待全局 `server.connected`。该事件没有 directory；目录 emitter 也以事件类型作为 name，原过滤条件无法触发补拉。相关历史决策：

- `../bug-fix/2026-08-28-sync-write-path-invariants.md`
- `../bug-fix/2026-09-03-sse-abort-on-stream-end.md`
- `../bug-fix/2026-09-16-network-service-crash-recovery.md`

## 决策

新增 `session_change` 短期标记表，不保存正文、工具输出或附件。标记、原投影与 `event_sequence` 同事务提交；即使 `publish: false`，标记也会保存。只记录仍存在的会话，删除会话通过外键清除标记，不复活已删除行。工作区完整事件表及其开关不变。

迁移 `20261009004029_session_change` 由 drizzle-kit 生成，只添加该表和时间索引，不重建旧表。事件 ID、message ID 最多 128 code points / 512 UTF-8 bytes；过长事件 ID 使用 SHA-256，无法定位消息的标记降级为 session 级。

保留策略由 `session_changes` 配置解析，缺省值为：

```jsonc
{
  "session_changes": {
    "enabled": true,
    "max_events_per_session": 256,
    "max_total_events": 10000,
    "retention_ms": 86400000,
    "page_size": 64,
  },
}
```

计数和时长须为正整数，page_size 上限 256。写入时裁剪过期、单会话超额和全局超额行；读请求不做清理写入，但不会返回过期标记。没有另开后台计时器。

只读 `GET /session/{sessionID}/changes` 接受 after、until、limit。单页最多 256 个标记；客户端以首次读到的 latest 固定分页目标。保留窗口缺口、中间/尾部缺号、关闭日志或游标领先于恢复后的数据库，都返回 reset，不假装已经补齐。读取不调用 replay、projector 或费用增量计算。SDK/OpenAPI 同步生成，并保留 oldest 的真实 `null`。

GUI 从全局通道监听重连。首次先读水位再刷新快照，应用成功才确认水位；后续按标记去重，读消息详情并完整替换 parts，清理已删除消息、parts 和陈旧文本 delta，再取得权威会话费用。费用是覆盖快照，不是再次入账。旧服务端 404、日志截断或超过 32 页时回退到已加载窗口的快照，不只追最新消息锚点。

每轮请求有独立 staging 和 generation；导航、更新中的 live 事件及新一轮补拉会淘汰旧请求，失败不推进游标。staging 在结束后释放，游标缓存跟随既有 session cache 上限和淘汰。空会话的窗口容量不取零。流式竞态重试有上限，idle 事件负责最终对齐。

补拉沿用既有 message-window 的历史阅读持有上限。快照回退时分页游标跟随实际返回窗口，不盲留更深的旧游标而跳过两者之间的历史；窗口外的旧消息仍可继续分页加载。

## 成本与恢复证据

隔离合成负载包含 1,080 次真实 SyncEvent 写入、58,533,592 字节累积载荷。对照仅切换新日志开关；不是实际模型或 GUI 性能基准。

- 关闭日志：一致性备份 1,445,888 字节。
- 开启日志：保留 336 个标记，估算元数据 22,936 字节；备份 1,495,040 字节，增加 49,152 字节（48 KiB）。
- 禁用自动 checkpoint 的压力条件下，WAL 从 64,478,032 增至 88,345,192 字节。新增事务写入和裁剪确有成本；这不是生产默认 WAL 行为，也不据此宣称速度提升。

在 WAL 活跃时使用 `VACUUM INTO` 生成独立一致性备份，再只读检查 integrity_check、foreign_key_check、29 条迁移历史、序号、标记及投影内容。保留 Soul ID、CNY/USD 费用和权限。另有回归先建立真实旧 28 条迁移的库，升级后核对原消息/parts 不变，并检查升级前备份仍可恢复旧结构。

## 验证

定向验证，不运行全仓测试，也不访问真实数据库：

- `test/storage/session-changes-migration.test.ts`：旧库升级、原记录、WAL 一致性备份及旧结构恢复。
- `test/session/changes.test.ts`：事务回滚、漏广播、重放幂等、正文不落日志、分页、保留裁剪、缺号 reset、费用读取不变及删除级联。
- `test/session/changes-config.test.ts`、`test/sync/{invariants,index}.test.ts`：配置及既有同步不变量。
- `test/server/httpapi-public-openapi.test.ts`：有限整数和可空游标契约；HTTP exercise 有新路由场景。
- `src/context/session-changes.test.ts`、`reconnect.test.ts`、`global-sync/event-reducer.test.ts`：全局重连、分页、真实 SDK 404 包装、失败/导航/流式竞态、完整消息替换、零窗口和有界回退。
- opencode、app 类型检查与 SDK 官方生成器。

## 边界与替代方案

不整体移植上游 event sourcing，不改变已有费用/人格投影，不复制完整载荷，不提供新的自动备份调度器。仅靠最大已接收 SSE seq 会跳过缺口，因此不将其当作已应用游标。

这批负责打开会话的持久投影对齐，不修首页会话列表的失败态、不等同于所有白屏的根因修复，也不是 Electron 内存治理。现场看到的加载错误与进程内存需要独立诊断；当前已打包客户端没有重编，不能把其现象归因到未部署代码。

## 模型可见四问

1. 模型看到什么变了：没有修改提示词、工具 schema/description、工具输出或注入段；新增的是 GUI/SDK 的 HTTP 协议。
2. token 影响：固定前缀零增量。
3. KV cache 影响：不改注入字节或顺序，没有前缀失效点。
4. 硬上限：无新增模型注入项。HTTP 标记单页 256，标识字段有字节上限；客户端最多 32 页后回退快照，数据库保留量由校验过的配置裁剪。
