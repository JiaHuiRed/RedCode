# sidecar 恢复的单一所有权（RC21-06）

状态:implemented

审计原文：`docs/2026-10-21-third-party-audit.md` 的 RC21-06。

## 问题

sidecar 猝死自愈有两个推动者，各自调一次 `respawnSidecar`：

1. 进程退出：`server.ts` 的 `child.once("exit")` → `onExit` → `handleSidecarExit` → `respawnSidecar`。
2. 健康失败：`respawnSidecar` 自己 `await health.waitUntilHealthy()` 失败后，在 `healthy=false`
   分支里 `killSidecar()` 再 `respawnSidecar`。

触发条件是「重启的 sidecar 已发 `ready`，但还没通过健康检查就退出」：退出回调看到 `server`
仍指着死者（猝死判定），健康等待又被 `getFailure` 立刻打穿，两条路同时成立。而
`respawnSidecar` 在**延时与 server 检查之前**就 `respawnTimes.push(now)` —— 同一次故障吃两个
恢复名额。两个计时器还可能在延时结束后各自拉起一个 sidecar（审计标注为待调度复现）。

预算耗尽时只写一行 `giving up`，界面没有任何「自动恢复已停止」的终态，用户只能看着
`Failed to fetch` 刷屏。

## 决策

新增 `src/main/sidecar-supervisor.ts`，把「谁可以推动恢复」收成一处：

- **代次**：每次 spawn 递增一个序号，进程退出与健康失败都带着代次上报；`settle` 只受理
  等于当前代次的那一次。`server` 变量不再承担「猝死 vs 有意停」的判别。
- **单任务**：恢复是一个 `recovering` promise，同一时刻只有一个；延时、启动、等待健康都在
  它的循环里，而不是每次故障各起一个计时器。
- **预算只在与受理时计一次**：`respawnTimes` 与 `attempts` 从「每次调用」改成「每次受理」，
  同一次故障无论几条信号到达都只占一个名额。时间窗闸门（10 分钟 5 次）与连续失败闸门
  （1s/3s/10s，三次）都保留在原位。
- **有意停**：`stop()` 置 `stopped` 并清当前代次，必须**先于**停进程调用。否则用户退出/
  切换工作区时，退出回调会把主动停当成猝死又拉起来。
- **状态发布**：`onState` 推 `starting / running / recovering / failed`，`failed` 带原因；
  `broadcastSidecarState` 发给所有窗口，渲染层在 `failed` 时显示状态条与重试按钮
  （`restart-sidecar` → `supervisor.retry()`，已有恢复任务时返回同一个 promise，不会并行）。
- **取消**：`quitting` 与 `stopped` 在每个 `await` 之后检查；进程被 kill 后健康等待会因
  `getFailure` 立刻 reject，所以最坏等待是一个 30s 健康超时之内，不是挂死。

`index.ts` 保留的职责只剩：怎么拉起（`spawnLocalServer` + 首次启动独有的迁移参数）、
怎么停（`stopCurrentSidecar`）、怎么记日志（`handleSidecarExit`）。

## 备选与否决理由

- **在 `respawnSidecar` 入口加一把锁**：否决 —— 锁能防并发，但解决不了「同一次故障被
  重复计入预算」，也说不清谁该在什么时候解锁；代次把「这次故障属于哪个进程」讲清楚。
- **继续用 `server === null` 判主动停**：否决 —— 那个判别在健康失败路径上依赖调用顺序
  （`killSidecar` 先置 null 再 stop），而审计发现的正是顺序假设失效。
- **把状态放在渲染层轮询**：否决 —— 轮询本身又是一条新的恢复线索来源，与「单一所有者」相反；
  主进程已经知道状态，推一次就够。
- **首次启动失败也自动恢复**：否决 —— 首次失败由 loadingTask 的失败路径弹窗并退出，这是
  既有的产品决定；自动恢复会把「装错/权限不足」这类确定性失败变成无限重试。

## 后果

- `ready → 健康等待 → 退出` 这一条路径只计一次预算、只拉起一个替代进程。
- 主动停（退出、切换、重启）之后迟到的退出回调不会再拉起服务。
- 预算耗尽进入 `failed`，界面有终态与重试按钮；重试不会产生第二个并行恢复任务。
- 日志事件名保持 `sidecar recovering / restart failed / recovery stopped`，时间窗与连续失败
  两道闸门的参数与原来一致。
- 验证：`sidecar-supervisor.test.ts` 7 条（首次健康、ready 前退出只计一次、旧代次迟到退出、
  有意停、quitting、预算耗尽 + 重试单任务、起来又死撞时间窗），与 `server-health.test.ts`
  合计 10 pass；`packages/desktop` typecheck 通过。
- **未做**：真机并发启动的调度复现（审计同样标注为待测）。测试用假 spawn/假时钟钉住的是
  状态机契约；Electron utilityProcess 的真实退出时序、以及两个计时器竞争拉起的现场，仍需要
  一次带日志的实机观察才能确认。
