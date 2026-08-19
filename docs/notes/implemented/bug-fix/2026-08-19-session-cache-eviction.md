# 会话级内存缓存的回收：TTL 为主、数量为辅

状态:implemented

## 问题

2026-08-19 全仓审计发现三处按 sessionID 累积、**没有任何删除点**的进程内 Map：

| 位置 | 每会话留下什么 |
| --- | --- |
| `session/prompt-caches.ts` `.system` | skills + env + instructions 全文，再按 modelKey 分桶 |
| 同上 `.tools` | 全部工具的 description + inputSchema |
| 同上 `.msgPin` / `.modelMsgs` | 整段被钉死的消息历史，长会话可达数 MB |
| `file/time.ts` `state` | 一整张「本会话读过的文件 → mtime」表 |

`settlePromptCaches` 只删 `msgPin` / `modelMsgs`，且只在 compact 边界触发；`system` / `tools` / `FileTime.state` 全无删除路径。全仓 grep 也确认没有任何 `Session.Event.Deleted` 订阅者做缓存清理（订阅它的只有 projectors / share-next / pty，都不碰这些）。

CLI 形态无影响——进程即会话，退出即回收。真正吃亏的是 **GUI sidecar 与 `serve`**：长驻进程，会话来来去去，四个 Map 只增不减。子代理还会放大这件事——每个 subtask 都是一个独立 sessionID，跑完就冷掉，但缓存留着。

## 决策

**回收口径用「冷」而不是「删」。** 会话被显式删除是少数情况，绝大多数只是不再被 prompt——盯着 `Session.Event.Deleted` 修不到主要矛盾，还要引入 bus 订阅的生命周期问题。

- **TTL 为主（1 小时）**：超过 1 小时没被使用即整会话摘除。此时 provider 侧的前缀缓存（分钟量级）早已过期，重建不多花一分钱，纯赚内存。
- **数量为辅（32 会话）**：只挡突发。上限取得宽松是因为**回收活跃会话是有代价的**——丢 `msgPin`/`modelMsgs` 等于让 DCP 攒下的改写一次性生效、整条前缀从最早改写处重写（就是 `5670d86` 刚花力气避免的那种全额重建）。单人使用下一小时内触碰超过 32 个会话不现实。
- **当前会话永不被自己这一轮的 touch 顺手回收掉**，即使它是最冷的那个。
- 两条都命中不了的极端情况，宁可留着内存，也不主动去打前缀缓存。

实现是惰性清扫而非定时器：`seen: Map<sessionID, 最后使用时刻>` 与四个缓存放同一个 globalThis 槽（分开放会让「模块被实例化多次」时各实例按各自的视图回收共享缓存）。`Map` 保插入序，重新插入即把自己挪到末尾，于是从头遍历就是「从最冷到最热」，撞到第一个还热的即可停。条目数是「近期会话数」量级，每轮扫一遍代价可忽略，也不必操心 timer 的 unref 与生命周期。

触发点：`prompt-caches` 在 runLoop 每轮构造 prompt 时 `touchSession(sessionID)`；`FileTime` 在 `record` 与 `assert` 里各触碰一次（读和写前断言都算活跃）。

## 回收的代价是 fail-safe 的

- `system` / `tools` 被回收 → 下次从磁盘重建。只要指令文件没变，重建出来的字符串逐字节相同，前缀不受影响（这两个缓存本来就是为了防「会话中途文件被改」而不是防重建）。
- `msgPin` / `modelMsgs` 被回收 → 等价于一次 settle，代价明确，所以靠宽松的阈值保证只发生在冷会话上。
- `FileTime` 被回收 → 下次覆写该文件时守卫要求先重读，**而不是放行旧内容**。对一个已经一小时没动静的会话来说这恰恰是更正确的行为：文件很可能真的变了。

## 备选与否决理由

- **订阅 `Session.Event.Deleted` 清缓存**：不作为主方案——只覆盖"显式删除"这一小部分，冷会话（绝大多数）照漏。作为将来的补充可以叠加，但不是这次的主要矛盾。
- **定时器周期清扫**：否决——要维护 timer 生命周期与 `unref`，而惰性清扫在这个数据量级上完全够用。
- **纯数量 LRU、不要 TTL**：否决——单人长驻使用下会话数常年低于上限，纯 LRU 等于永不回收，内存在空闲一夜之后仍然满着。
- **给 `FileTime` 的每会话文件表也加条目上限**：暂缓——会话内维度的增长受真实工作量约束（读几千个文件也就 MB 量级），且截断会造成"读过却被要求重读"的突兀失败。会话维度封顶后总量已经有界。

## 后果

- 测试：`test/session/prompt-caches.test.ts` 新增 5 例（dropSession 摘四个缓存 / TTL 边界 `<=` 判留 / 当前会话永不自我回收 / 数量上限挤掉最冷 / 反复 touch 同一会话不误伤别人），时间通过 `touchSession(id, now)` 注入。`test/file/time.test.ts` 新建 3 例（数量上限有界、活跃会话不被挤掉、守卫语义不受回收影响——没读过仍拦、读后被外部改动仍拦）。
- `FileTime` 的 TTL 分支没有单独用例：`record`/`assert` 不暴露可注入的时钟，而那一支与 `touchSession` 是同一份逻辑，时间可注入的完整用例在 prompt-caches 侧。
- 同批审计里还有一处同形状的 `globalThis.__prefixProbe`（`prompt.ts` 的诊断探针，同样无界），未在本次处理——它属于「诊断代码要不要留」的更大问题，见审计清单第 6 条。
