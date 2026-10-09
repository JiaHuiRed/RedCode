# 全局 SSE 每连接缓冲双限额，溢出显式失败并重连补拉

状态:implemented

## 问题

`/global/event` 使用未传 options 的 `Stream.callback`；本仓 Effect 4.0.0-beta.66 的 callback 最终调用 `Queue.make`，缺省 capacity 为 Infinity。客户端停止消费时，GlobalBus 同步发布仍会把载荷持续放入每连接队列。

真实 HTTP 回归先暂停 reader，再同步发布 4,096 个小事件。旧实现仍保留订阅（预期 0、实际 1），新实现达到预算后移除订阅并结束响应。这个测试证明缓冲机制，不证明用户现场 5GB 的内存归因；没有制造大内存负载。

实例 `/event` 的 wildcard Bus 已有 sliding(4096)，不是同一个无界点。本批不改 typed Bus、生产者或实例事件策略。

## 决策

- 只替换全局流的订阅缓冲。每连接采用 dropping 队列，预算由配置拥有方 `ConfigServer.resolveEventBuffer` 显式解析：

  ```jsonc
  { "server": { "sse": { "max_events": 256, "max_bytes": 8388608 } } }
  ```

  两项均为有限正整数；缺省 256 条、8 MiB 序列化 UTF-8 event data。连接创建时读取全局配置，已有连接沿用创建时预算。
- 条数与字节同时检查，单个过大事件也触发溢出。不只按条数限制包含附件、diff 的大载荷。入队前沿用 `eventData` 的 WeakMap 序列化缓存，不重复 stringify。
- 超限同步移除 GlobalBus listener、记录仅含原因/限额/计数的 warning、以 `GlobalEventStreamError` 使流失败。不堵住同步发布者，不继续接收事件，不静默丢数据后假装流完整。已入队的有限前缀可排空后失败；客户端完全暂停时不能保证立即完成 TCP 断连，但队列不再增长。
- 序列化失败也只终止该订阅，不把异常抛回同步 emit、不影响后续 listener；不记录原始 error 或载荷。循环引用小载荷回归先红后绿，避免把从 pull 边界移到 producer 边界的工作变成新的错误传播路径。
- `server.connected` 在 listener 安装后才入队，ready 不早于订阅就绪；取消、正常 scope 结束及溢出均清 listener。原心跳、SSE headers、不压缩策略保持。
- GUI 沿用单条共享事件流、外层退避重连和全局 `server.connected` 的短期变更日志补拉。打开会话按权威消息/parts/费用快照恢复，不新增完整 event 表双写。参见 `../feature/2026-10-09-session-change-catchup.md`。

## 备选与否决理由

- **纯 sliding 丢最旧事件**：否决，客户端不知道缺口，可能永久留下旧 parts/费用。
- **阻塞有界队列**：否决，GlobalBus 是同步 EventEmitter，慢客户端不能阻塞任务生产者。
- **复制上游 256 常量、不提供配置或字节预算**：否决，不同部署需求不同，单条大载荷仍可突破实际缓冲预算。
- **改为持久完整载荷 SSE 重放**：否决，会重新引入已否决的正文/附件重复存储。

## 验证与边界

定向测试覆盖配置合法性、条数超限、累计 UTF-8 字节、单条超限、正常消费释放预算、取消清理、重新订阅、编码异常隔离与真实 HTTP 慢消费结束；同时回归 SSE 编码缓存、不压缩策略及 GUI 补拉。SDK/OpenAPI 由官方生成器同步。

限额针对订阅层 event data，不等于整个进程 RSS：序列化当前事件、在途 chunk、SSE/HTTP 编码和操作系统 socket 缓冲仍有有限额外开销。Effect 的 merge 为容量 0 的 rendezvous，不引入无界第二队列。没有修改提示词、工具 schema/输出或模型注入；固定前缀 token/KV cache 影响为零。

未重编当前桌面 exe、未做 5GB 现场复刻；不宣称消除全部 GUI 内存增长。实例流 sliding 缺口、未打开会话列表与瞬态通知的补偿不在本批保证范围内。

单个合法事件超过预算也会触发重连；大事件密集的部署需要调高预算或另做载荷瘦身，不能靠此队列保留无限数据。恢复依赖当前会话 HTTP 补拉，不依赖重放同一大事件。
