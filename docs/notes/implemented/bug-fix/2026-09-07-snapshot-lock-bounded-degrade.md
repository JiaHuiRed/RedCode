# 快照锁热路径改有界等待+降级，prompt 不再被锁堵死

状态:implemented

## 问题

prompt 链路第 0 步（`session/processor.ts` 的 `create()`）与每个 step 的收尾都要跑 `snapshot.track()`/`finish()`，它们与 `restore`/`revert` 共用 `locked()`：Flock 默认 **5 分钟**等待 + 进程内无超时信号量，且临界区内串多个 120s 上限的 git 子进程（`add()` = sync + diff-files + ls-files + check-ignore + 逐文件 stat + git add）。

另一进程持锁跑慢 git 时，本会话 prompt 被堵在 LLM 调用之前。260907 实测形态：`session.prompt step=0 loop` 起跑后 94 秒无任何 LLM 调用日志、无报错，用户侧一直「等待响应中」直至实例死亡；同晚 18:58–19:03 日志里反复出现 `Timed out waiting for lock: snapshot:...`（等满 5 分钟的 Flock defect 直接炸掉请求）。换任何供应商都无效，因为请求根本没发出去。

## 决策

- 新增 `lockedSkip(op, fx)`：等快照 Flock 最多 `BUSY_WAIT_MS = 10s`（复用 `Flock.tryAcquire` 单次尝试 + 退避 sleep，等待可中断），拿不到就 `log.warn` 并跳过本步快照。
- `track`/`finish`/`patch`/`cleanup` 切到 `lockedSkip`，降级形态复用既有「快照禁用」路径：`track→undefined`、`finish→{hash:undefined, patch:undefined}`、`patch→空 files`。丢的只是这一步的 diff 统计，会话照常继续。
- `enabled()` 判断移到锁外，禁用时不再碰锁。
- `restore`/`revert`/`diff`/`diffFull` **保持** `locked()` 原语义：撤销是用户显式操作，宁可等也不能静默跳过；diff/diffFull 不在聊天热路径上。

## 备选与否决理由

- **给 prompt 路径的整次 track/finish 套 Effect.timeout**：否决——超时会打断已持锁、正在跑的 git 子进程，留下孤儿进程写半截索引；锁获取阶段打断才是安全的（等待期不持任何资源）。
- **全局调低 Flock 默认 timeoutMs**：否决——Flock 是共享基础设施（npm、models-dev 等都在用），动全局参数影响面不可控。
- **把 Flock.effect 的超时从 defect 改成 typed failure 再捕获**：否决——260827 的注释明确「超时保持 defect」是既定行为，为单一调用方改全局语义不值。
- **持锁时长本身再收紧（调低 git 120s 上限）**：否决——260821 的 120s 是防「永久冻结」的宽松值，调小会误伤大仓首次快照；本 note 解决的是「等锁的人不该陪葬」，不是「持锁的人太快」。

## 后果

快照锁被别的进程长期占住时，聊天最多慢 10 秒（之后每步一条 warn），不再出现分钟级「等待响应中」直至中断。诊断指纹：`snapshot lock busy — skipping op` 的 warn 连续出现 = 有另一进程/实例在长期持锁，该去看实例生命周期而不是供应商网络。

已知残留：持锁方自己的 git 操作仍可能慢（最多每个子进程 120s，有 260821 的超时日志兜底）；持续争用期间会话的 diff 统计会缺步。跨进程并发写 git 索引仍由 git 自身的 `index.lock` 兜底（260904 决策不变）。
