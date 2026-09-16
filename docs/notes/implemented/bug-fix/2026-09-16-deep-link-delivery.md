# Deep links are delivered exactly once across renderer readiness and reloads

状态: implemented

## 问题

Desktop renderer used `redcode:deep-link`, while the app layout listened for `RedCode:deep-link`; DOM event names are case-sensitive, so live deep links were dropped after the layout mounted. Main also retained every link after sending it, and renderer retained every event before dispatching it, so simply correcting the spelling would replay already-consumed links after a renderer reload.

## 决策

- `deepLinkEvent` is exported by `@redcode-ai/app` and used by both app and desktop renderer.
- Main owns a small delivery state machine. It queues links until the renderer explicitly reports ready, sends live links afterwards, and resets to queueing during a renderer load.
- Renderer registers its IPC listener, drains initial links, then marks itself ready. App layout keeps a local pending queue only until its event listener mounts.

## 备选与否决理由

- **只改事件字符串**: 否决——会留下 reload 后重复消费的 pending 链接。
- **mainWindow 存在即视为 renderer ready**: 否决——窗口创建与 layout listener 挂载之间仍有丢失窗口。
- **每次发送后直接清 main queue**: 否决——不能确认 renderer 实际已订阅 IPC。

## 后果

Deep links are buffered only across startup and reload boundaries. Main delivery 的纯函数测试覆盖 startup、live、reload 和发送失败；app 测试覆盖共享 event 名及 renderer-local pending 队列。
