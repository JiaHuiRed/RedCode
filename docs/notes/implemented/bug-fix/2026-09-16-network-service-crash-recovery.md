# Network Service 崩溃后由主进程通知渲染层立刻重建事件流

状态: implemented

## 问题

GUI 反复出现「会话跑着跑着白屏」「从别的会话切回来白屏」，有时只有消息区空、有时文件树与消息区一起空。用户长期怀疑是渲染或性能漏洞。

定位结论：**Electron 的 Network Service 子进程崩溃，且渲染层对它完全无感。**

- `%APPDATA%/ai.redcode.desktop.dev/logs/20260916T104757/utility.log`：`child process gone { type: 'Utility', reason: 'crashed', exitCode: -1, serviceName: 'network.mojom.NetworkService' }`（22:47:26）。09-10、09-11 两份日志有同样记录，约每天到几天一次。
- renderer 侧**无未捕获异常**、Crashpad **无 dump**、主进程**无** `render-process-gone`/`unresponsive`——不是渲染或性能问题。
- 到 sidecar 的 TCP 连接全部归 Network Service 进程所有（renderer 自己零连接），它一崩全部网络 I/O 中断，数据驱动的区域随之变空。这也解释了为什么文件树与消息区会一起白。

真正把白屏拉长的是**恢复延迟**：崩溃后 fetch 既不 resolve 也不 reject（静默挂住），要等心跳超时才判定断线。实测 22:47:26 崩溃 → 22:48:54 才出现 `stream ended, reconnecting (sinceLastEventMs=90003, exceededHeartbeat=true)`，中间 88 秒是纯空白。

会话数据的补拉本身早已存在（`pages/session.tsx` 监听 `server.connected` → `sync.session.sync(id, { force: true, anchor })`，09-13 提交，且已验证在出事那次的构建产物里）。真正的瓶颈只是「多久才发现该重连」。

## 决策

崩溃只有主进程能感知，新增一条最小通路把它转成渲染层可消费的信号：

- `main/index.ts` 的 `child-process-gone` 里识别 `serviceName === "network.mojom.NetworkService"`，向所有窗口 `send("network-service-restart")`（该监听此前只写一行日志）。
- `main/ipc.ts` 新增 `sendNetworkServiceRestart()`，与既有 `sendDeepLinks`/`sendMenuCommand` 同形。
- preload 新增 `onNetworkServiceRestart(cb)`，与既有 `onMenuCommand` 同形（`types.ts` 同步声明）。
- desktop renderer 把通知计成递增计数，以 `networkServiceRestart` 暴露到 `Platform`，与既有 `webviewZoom: Accessor<number>` 同形。
- app 的 `global-sdk.tsx` 监听该计数变化后 `attempt?.abort()` 立刻拆掉旧事件流——abort 走既有重连路径（与 `visibilitychange` 那条超时兜底同一机制），重连成功后的 `server.connected` 再触发既有会话补拉。

不动桌面端启动/生命周期，不新增面板或 UI。

## 备选与否决理由

- **缩短 `HEARTBEAT_TIMEOUT_MS`**：否决——它是全局判据，缩短会把正常网络抖动也判成断线；用崩溃这一确定性事件更准。
- **让渲染层自己感知崩溃**：否决——崩溃时 fetch 静默挂住，渲染层拿不到任何可观测信号，只能靠超时。
- **崩溃后 `webContents.reload()`**：否决——能恢复但丢掉全部界面状态与草稿，代价远大于收益。
- **在 main 侧重建到 sidecar 的连接**：否决——连接属于 renderer 的会话，main 无法代持。

## 后果

- 恢复时间从约 90 秒压到秒级。崩溃本身仍会中断一次所有在途请求（无法避免），只是不再长时间无响应。
- **未覆盖**：崩溃诱因仍未知——Crashpad 里没有 utility 进程的 dump，拿不到崩溃栈；可能方向（超大 payload、连接池压力、Electron 44.2.0 自身缺陷）需单独定位。
- 识别签名：若白屏仍出现、且 renderer 日志里**没有**新的 `stream ended, reconnecting`，说明走的是别的路径（store 被淘汰、渲染层问题等），不是本 note 覆盖的场景。
