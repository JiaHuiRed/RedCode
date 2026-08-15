# MessageID 48 位回绕致 runLoop 死循环：比较一律改 time.created，ID 扩容 64 位

状态:implemented

## 问题

2026-08-14 19:18-20:08，会话 `ses_0053f5027ffejOtSeYuR7APUkd`（GUI，deepseek-v4-flash）在无人输入时自产 219 条 assistant 消息（每 5-6 秒一条、全部 parent 指向 19:18:23 那条 user 消息），烧掉 cacheRead 约 2049 万 token、$1.3，直至用户手动中断。

根因链（数据库实锤 + 代码验证）：

1. `id.ts` 的 ID 编码 = `Date.now()*4096 + counter` 压进 6 字节（48 位），**回绕周期 2^36 ms ≈ 795 天**。
2. 2026-08-14 19:19:55.136 恰为第 26 次回绕点（26 × 68,719,476,736 ms）。回绕前最后一条消息 `msg_ffffffc7d001...`（ffff 前缀），回绕后第一条 `msg_000011a87001...`（0000 前缀）——**新 ID 字典序反而更小**。
3. `MessageV2.latest()` 用字符串比较 `info.id > user.id` 取「最新」消息 → 回绕后永远选中 ffff 前缀的旧 user 消息。
4. `prompt.ts` runLoop 退出条件 `lastUser.id < lastAssistant.id` 恒 false → 永不 break → 空转。

触发条件 = 三个巧合叠加：长任务 runLoop 存活 25 分钟 + 恰好跨越回绕时刻 + 会话里残留回绕前消息。修前影响不随该会话结束消失——任何 8-14 之前创建、之后仍活跃且消息未被裁剪的会话都中招；下次回绕在 2028-10 中旬。

## 决策

**比较先后一律用 `time.created`（毫秒），ID 只做 identity。** 同毫秒 tie-break 用 ID 字典序——同 ms 内 counter 递增、字典序正确，仅 1ms 回绕窗口可能并列（概率趋零）。

- opencode 端：`MessageV2.compareTime()` 新增并替换 `latest()` 三处 max、tasks 边界、runLoop 退出条件、busyEnter 边界（turnStart 改存消息本体）、fork 截断、revert 范围与 cleanup 边界——共 9 处。
- TUI 端：`cmpTime()`（`tui/context/sync.tsx`）替换会话路由 7 处（undo/redo/revert 渲染/queued/子会话排序）；`Binary.searchBy()`（core，自定义比较器二分）替换消息数组的按 id 二分插入——消息数组按 (created, id) 升序维护。
- app 端：`compareTime()`（`app/src/utils/id.ts`）替换消息/会话排序合并、revert 过滤边界共 18 处；parts 合并退化为 id 字典序（Part 无 created 字段，同消息内回绕概率趋零）。
- **ID 编码 6 字节 → 8 字节（64 位）**，三份实现同改（opencode/app/core）：时间戳空间 2^52 ms（约 14 万年）内不回绕；`timestamp()` 解码兼容旧 12 hex / 新 16 hex。ID 总长 26 → 30（random 尾部恒 14 位）。

后端 DB 分页本就 `orderBy(time_created, id)`，无需数据迁移；修复上线后旧会话自动恢复正常。

## 备选与否决理由

- **只修比较、不动编码**：否决——795 天后回绕再现，届时 `timestamp()`/truncate 失真且无人记得此坑；比较层修完后编码扩容无残留风险。
- **ID 内嵌进程内单调补偿（记录 lastEncoded 不回绕）**：否决——跨进程/重启失效，且破坏时间可解码性。
- **比较改用 `timestamp(id)` 解码值**：否决——48 位信息已丢，解码值本身就是回绕后的假时间戳。
- **数据迁移重置旧 ID**：否决——无必要，比较层修复后旧数据自动正确。

## 后果

- **新 ID 长度 30（+4）**：与旧 ID 混合存在。任何残留的裸 ID 字典序比较会彻底乱序（12 hex vs 16 hex）——因此铁律：**ID 禁止用于表达先后，一律 `compareTime`/`cmpTime`/`time.created`**。识别签名：代码里出现 `.id < `、`.id > ` 的消息/会话比较。
- `Binary.search` 系列只在排序键与 key 函数一致时合法（parts/requests 保持 id 字典序，未动）；TUI session 数组按 `updated desc` 排，其按 id 二分本就 mismatch（回绕前既有行为，本次未扩大范围）。
- 回绕现场会话 `ses_0053f5027f...` 已 abort，无需处理；TUI 打开应恢复正常交互。
- 测试：`test/id/id.test.ts`（64 位编码回归）、`message-v2.test.ts` 新增 compareTime 回绕场景 5 例（用真实回绕前后 ID 对）。
