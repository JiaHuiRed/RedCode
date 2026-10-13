# CI 锁恢复测试：子进程 close 监听必须先于 kill

状态:implemented（工作区修复，尚未提交；远端待新 SHA 验收）

## 问题

run `38340578068` 首次在普通 flock 的崩溃恢复用例挂满 20 秒，重跑在 effect-flock 同构用例挂满 30 秒。两个测试都先 await stopWorker，再订阅 worker 的 close；Windows helper 又先等待 taskkill 退出。worker 可能在这个窗口内已派发 close，而 EventEmitter 不重放事件，后补 promise 永远不返回。

不能仅凭 CI 超时排除锁算法问题。本批先将三处匿名等待抽成实际 waitClose helper，行为仍为事后订阅；用真实子进程预先等待其 close，再调用该 helper。两个有界探针均确定失败，报 `close event was missed after worker termination`。这是竞态形状的直接复现，不是复刻锁算法的 shadow 测试。

## 决策

- 两套 helper 均先建立 close 等待，再执行 kill；stopWorker 自己完成退出等待。
- 删除普通 flock 两处和 effect-flock 一处事后补监听。
- 已终止的 worker 直接完成等待；排空 stdout/stderr，避免管道阻止关闭。
- worker 退出等待和 taskkill 各设 5 秒上限；超时或启动失败明确拒绝，不无界挂起。

不改生产 Flock / EffectFlock，不调整 staleMs，不延长原用例 timeout，不清空断言。

## 备选与否决理由

- **再重跑 CI**：已有两次同构失败；本地偶尔绿不消除事件竞态。
- **延长测试或 stale-lock 参数**：漏掉的 close 不会重放，加时不能修复。
- **改共享锁默认等待**：影响生产调用方且没有本次证据支持；与 [快照锁有界降级](2026-09-07-snapshot-lock-bounded-degrade.md) 的边界保持一致。

## 后果与验证

原三个调用点继续等待 worker 终止，但监听窗口提前，等待有界；其他同步订阅的 run/taskkill helper 不作无关改造。

修复后 `bun test ./test/util/flock.test.ts ./test/util/effect-flock.test.ts --timeout 30000`：27 pass / 0 fail，core typecheck 通过。两个回归直接调用实际 helper，使用已关闭的真实子进程；原崩溃恢复与健康锁等待用例仍在两文件中运行。

本机 Bun 1.3.14 的通过不替代 CI Windows/Bun 环境验收。旧 SHA 的 CI 仍红，本批尚未提交推送，不能声称全仓已绿。

模型可见面不变：本批仅测试脚手架与回归，无提示词、工具或运行时锁行为变更。
