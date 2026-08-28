# sync 写入路径：序号门控错位 + 投影豁免靠名字子串

日期：2026-08-28 · 状态：implemented · 来源：读 `packages/opencode/src/sync/` 写入路径（起因是与 deepseek-harness 对比测试覆盖率时逐条读代码）

## 问题

`sync/` 是 411 行的事件溯源写入路径（`run → process → projector + 两张表 + bus`）。既有的 `test/sync/index.test.ts` 覆盖了 run/replay 正常流，但它的 layer 写死 `experimentalWorkspaces: true`，**只验了 flag 开的那一半**。读代码找出三处结构问题：

### 1. 序号的读与写不同门控（默认配置下 seq 恒为 0）

`run()` **无条件**读 `event_sequence` 算 `seq`，而 `process()` 里两条 insert 都在 `if (options.experimentalWorkspaces)` 后面。该 flag 默认 **false**（`effect/runtime-flags.ts`，要 `REDCODE_EXPERIMENTAL=true` 或 `REDCODE_EXPERIMENTAL_WORKSPACES=true`）。

结果：默认配置下计数器行从不落库 → 每个事件的 `seq` 恒为 0，而这个 0 仍被 `GlobalBus.emit` 原样广播。更糟的是 flag **中途打开**时序号从 0 重新开始，对端 `replay()` 的 `event.seq <= latest` 判据会接受它，**静默地缺掉全部历史**。

远程 workspace 同步本身也在同一个 flag 后面，所以这条路默认整条休眠——不是线上故障，是一条**正确性从未被执行过的持久化路径**。

### 2. 投影豁免的判据是事件名子串

```ts
if (!def.type.includes("next")) throw new Error(`Projector not found for event: ${def.type}`)
return
```

「忘写 projector」的护栏，对着唯一还在增长的命名空间（`session.next.*`）整个关掉了；而且这个 `return` 在插入块之前，**同时跳过投影、持久化与 bus 发布**。下一个名字里碰巧带 next 的事件（`plugin.nextcloud.synced`）会免费拿到同样的豁免。

### 3. run 与 replay 的 data 不同源

`run()` 把内存对象原样交给 projector；`replay()` 拿到的是 JSON 往返之后的产物（`EventTable.data` 或 HTTP body）。中间**没有一次 `Schema.encode`/`decode`**。显式 `undefined` 的成员只在前者可见，所以任何用 `key in obj` 区分「清空该字段」和「不动该字段」的 projector，两条路径语义不同。

## 决策

1. **`event_sequence` 的 upsert 移出 flag，`event` 表的插入留在 flag 后面**。计数器是一个 aggregate 一行三列，代价可忽略，而它是 `seq` 的唯一真相，必须与读同门控；事件全文体积大且只有 workspace 同步要用，继续按需。副作用是好的：flag 中途打开时对端因 `seq` 从 N 起跳而抛 `Sequence mismatch`（响），而不是接受一条从 0 重开、缺掉历史的流（哑）。

2. **豁免改成显式名单**：`SyncEvent.init({ nonProjecting })`，生产值在 `server/projectors.ts` 的 `NON_PROJECTING_EVENT_TYPES`。当前只有 `session.next.tool.progress` 一个——它只驱动内存里的消息拼装（`session-message-updater`），没有落库形态。测试用**集合相等**断言把名单与实际缺口逐条对齐。

3. **第 3 条不加运行时护栏，只钉成已知事实**。试过在 `run()` 入口统一拒掉显式 `undefined`：**不成立**——本仓构造事件时把可选字段留成 `undefined` 是普遍写法（如 `session.created` 的 `info.workspaceID`），加上那条 throw 会打挂 146 个既有测试。这条契约由**关心键存在性的 projector 自己**负责：`session/projectors.ts` 的 `grab()` 是唯一一个，它对显式 `undefined` 直接抛错、要求改传 `null`（`null` 能 JSON 往返，两条路径因此一致）。新增会做 `in` 判断的 projector 时必须照做。

## 备选与否决理由

- **把持久化写入整个移出 flag**：否决。`event` 表存事件全文，等于把整个会话再存一遍；而它只有 workspace 同步要用，而那本身是实验特性。
- **在 `run()` 里把 data 做 JSON 归一化**（`JSON.parse(JSON.stringify(data))`），让两条路径按构造相同：否决。它会把 `grab()` 那条**响亮的**报错变成静默跳过字段——用一致性换掉了唯一的告警，方向是反的。
- **把集合相等断言做成 `init()` 的启动期检查**：否决。会把「加事件忘了 projector」的失败时机从事件触发提前到进程启动，爆炸半径不成比例。放在 CI 测试里，效果同等而风险为零。

## 验证

新增 `test/sync/invariants.test.ts`（12 例，两个 `it` 分别绑 flag 开/关）：

- flag 关时 `seq` 逐 aggregate 递增到 0/1/2、`event` 表保持为空、多 aggregate 计数互不干扰
- 声明的 EventV2 类型全部「有 projector 或在豁免名单里」；豁免名单无死条目
- 缺 projector 且未豁免 → 抛错；**名字含 "next" 不再是免死金牌**（回归）
- run 与 replay 对可 JSON 往返的 data 产生同一份 projector 输入
- 显式 `undefined` 在 run 可见、在 replay 不可见（把分叉钉成已知事实，谁抹平它谁红）
- `toPartialRow` 对显式 `undefined` 抛错、键缺失放行、`null` 落成清空

`bun test test/sync/` 23 pass / 0 fail；`bun run typecheck` exit 0。回归面跑了 `test/session/ test/v2/ test/control-plane/`（582 例）：改动前后都只剩 `workspace CRUD > sessionWarp applies source workspace patch to local target workspace` 一条失败，用备份+checkout 做过对照，**是既有失败不是本次引入**。

## 记账（读代码时发现、本次没做）

- `replay()` 在**事务外**读 `latest`/`ownerID`，随后 `process()` 才开一个不带 `behavior` 的事务（默认 deferred）；而 `run()` 显式用 `immediate` 并在注释里写 "critical"。两条路径隔离级别不对称。
- `convertEvent` 返回 Promise 时走 `void result.then(publish)`，**发布脱离 seq 顺序**。当前生产实现是同步的，属潜伏。
- `remove()` 删掉整条计数器行，同一 aggregateID 复用会从 0 重开，对端静默丢弃。
- `versionedType(type, 0)` 退化成裸 type，与「未版本化」撞键。
- `claim()` 不是 CAS、不看影响行数；`replay()` 的 owner 不匹配静默 return。**这两条是既有测试钉住的有意行为**（`index.test.ts` 的 "claim updates the event sequence owner" / "ignores replay from a different owner"），不是疏漏——要改得先改那两条测试的意图。
