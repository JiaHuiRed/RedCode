# 后台快照与 PTY 生命周期硬化：坏记录不阻断恢复、退出事件不丢、终止先确认

状态:implemented

## 问题

0.15.0 审计的三条 P2，都出在「进程/状态已经变化，但记录与监听还停在旧假设」：

- **RC-015-03**：`Pty.create` 先 `sessions.set` + `persist()`（异步磁盘 I/O），之后才挂 `onData`/`onExit`。短生命周期进程可能在落盘期间退出，退出事件不重放，登记永远停在 running。
- **RC-015-04**：`BackgroundStore.read()` 只校验 `records` 是数组。`records:[null]` 这类合法 JSON 会让 `hydrate()` 与 PTY 恢复读字段时直接抛，单个坏记录阻断整个工作区的恢复。
- **RC-015-05**：`Pty.remove` 先删内存与磁盘登记、再 `teardown()`；Windows 的 `taskkill` 既不 await 退出码也不记录失败。杀失败时面板已经看不到这个终端，实际进程还活着。

## 决策

1. **监听先于落盘**（`pty/index.ts` create）：`spawn` 返回后同步 `sessions.set` → 挂 `onData`/`onExit` → 最后 `persist()`。异步 I/O 不再位于「进程可能已退出」与「退出监听已挂好」之间。
2. **边界逐条校验**（`background/store.ts` read）：新增 `isEntry` 守卫，校验 id/type/status/started_at/completed_at/metadata 的关键类型；坏项丢弃并 `console.warn` 计数，好项照常恢复。`hydrate` 与 PTY 恢复因此只面对合法 Entry。
3. **终止先确认**（`pty/index.ts`）：`teardown` 改为 Effect 化的 `stop(session)`——Windows 上用可等待的 `taskkill`（5s 超时），退出码非 0 时用 `process.kill(pid, 0)` 做存活复核（EPERM 视为存活，只有 ESRCH 算结束）。`remove` 只有 `stop` 返回 true 才删登记并落盘；未确认时保留记录并 `log.warn`。实例 finalizer 同样保留未确认终止的终端，下次启动以孤儿身份继续可见。

## 备选与否决理由

- **RC-015-04 用完整 Schema 解码**：否决——`BackgroundStore.Entry` 是跨 namespace 的公共形状，PTY 的 metadata 是自由载荷；用 Schema 解码要么给 metadata 建联合类型（每个 namespace 都要注册），要么在 read 里对未知载荷过度防御。字段级守卫足够，namespace 自己的载荷仍由 `orphanFromEntry` 校验。
- **RC-015-05 按 taskkill 退出码直接判定**：否决——退出码在不同 Windows 版本上对「进程不存在」与「拒绝访问」的区分不稳定；以存活探测为准，退出码只作为诊断信息。
- **RC-015-05 让 remove 返回错误给 UI**：暂不做——接口变更会牵动 HTTP/SDK 形状；当前保留记录已能让面板继续显示，用户可重试。

## 后果

- 终止失败的终端会留在列表里（状态仍是 running），直到重试成功或进程自行退出；这是有意的诚实行为。
- finalizer 可能因逐个等待 `taskkill` 而变慢（上限 10 个终端 × 5s），但只在实例回收时发生。
- 识别签名：面板里「删不掉的终端」先看 `taskkill did not confirm termination` 告警；启动后出现 `skipped N invalid record(s)` 说明快照里有坏记录被丢弃。
