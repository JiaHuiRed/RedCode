# SSE 流正常结束时补上 abort：收尾不对称，疑似 GUI 冻结的真凶

状态：implemented（修的是**已证的收尾不对称**；连接池耗尽那条**仍是假设**，判法见文末）

## 问题

GUI 反复出现一种冻结（09-01 那次是最新一例，哥哥在家里那台遇到）：

- 左侧文件树 + 右侧上下文面板**同时空白**
- 消息发得出去（前端看得见），但**没落进数据库**
- Esc / 终止按钮点了没反应
- **但任务仍在推进**

`docs/notes` 与记忆里此前把它归因为「客户端 SSE 的重连被 SDK 架空」，`65582cc9`（09-02 15:09）
按那个结论修了：`sseMaxRetryAttempts: 1` 把重试权收回上层 + 退避归零点挪到「收到第一条事件」。

**修法当晚（09-02）又犯了一次，症状逐条相同。** 所以那个根因至少不完整。

### 旧结论解释不了一半症状

SSE 是**入站**通道。而「消息发得出但不落库」「Esc 无效」是**出站** HTTP。
SSE 断掉不该让 POST 失败。两者一起死，说明有个**共用资源**被占死了。

## 已证的缺陷

`global-sdk.tsx` 与 `server-sdk.tsx` 的重连循环，`finally` 里是：

```js
} finally {
  abort.signal.removeEventListener("abort", onAbort)
  attempt = undefined      // 只丢引用，不 abort
  clearHeartbeat()
}
```

同一个文件里其余五处（stop、心跳超时、onCleanup 等）**都是 `attempt?.abort()`**，
唯独「流正常结束」这条路径不是。AbortController 是保证底层 fetch 被拆掉的唯一把手，
置 `undefined` 只是让 GC 有机会回收，**不保证 socket 立刻关**。

这条不对称本身就是错的，与下面的假设成不成立无关。

## 假设（未证）：renderer 的连接池被耗尽

四个前提都已核实：

| 前提 | 实测 |
|---|---|
| sidecar 是 HTTP/1.1 | `server.ts` 用 `node:http` 的 `createServer()`，无 h2 |
| 本地场景 SSE 走 renderer 的 Chromium fetch | `eventFetch` 只在**非 loopback** 才返回 `platform.fetch`（`global-sdk.tsx` 开头），本地一律 `undefined` |
| **两条**常驻 SSE 流 | `global-sdk` 与 `server-sdk` 各调一次 `global.event` |
| 重连是紧循环 | `RECONNECT_BASE_MS = 256`，上限 2000 |

Chromium 对同一 host 是 **6 个连接**。两条 SSE 常驻占 2 个，剩 4 个给文件树、上下文面板、
消息 POST、终止请求。旧连接不释放 + 256ms 起步的重连 ⇒ 槽位吃光 ⇒ **之后所有到该 origin
的请求无限排队**，而服务端毫发无伤、任务照常推进。

这一套能**同时**解释全部症状，还能解释另外两件旧结论解释不了的事：

- **TUI 为什么从不犯**：默认传输根本不建 socket。`cli/cmd/tui/thread.ts` 分两条路，
  非 external 时 `url` 是假的 `http://redcode.internal`、`fetch` 换成 `createWorkerFetch`
  （HTTP 请求变成 `client.call("fetch", …)` 的 worker RPC）、`events` 换成
  `createEventSource`（走 `client.on("global.event")`）。没有连接池可耗尽。
- **为什么偏偏是配置更好、网更快的那台**：紧循环与竞态，机器越快越容易中招；
  慢机器常被自身延迟掩盖。

并且它解释了**为什么 `65582cc9` 之后反而当晚就犯**：那次把重试权从 SDK 收回上层，
SDK 那圈的起始退避是 **3 秒**，应用层这套是 **256ms** —— 同样的断流，开新连接的频率快了十倍以上。
如果泄漏成立，那个修法会把这条从「偶发」推到「当晚就中」。

## 决策

先补上已证的那处不对称（两个文件各一行 `attempt?.abort()`，放在置 `undefined` 之前）。
`abort()` 幂等，流已正常结束时是 no-op，只有还挂着才真正生效 —— 所以这条改动
**不依赖上面的假设成立**，无论如何都该有。

## 备选与否决理由

- **让 loopback 也走 `platform.fetch`**（把两条 SSE 整个挪出 renderer 连接池）：**暂缓**——
  代码路径现成，只被 `!loopback` 挡着，但**不清楚当初为什么这么挡**。动之前要先弄明白，
  否则是拿一个未知换另一个未知。假设被证实后这才是治本改法。
- **加大重连退避**：否决——那是把症状往后推，不是修泄漏；而且会让真实断连的恢复变慢。
- **等复发再修**：否决——收尾不对称是确定的错误，不该拿它当观测手段。

## 后果

- 若假设成立，这一条应当足以止住：连接在流结束时立刻释放，槽位不再累积。
  **下次若仍复发，说明泄漏不在这里**，直接走下面的判法，别再在重连逻辑里找。
- **判定假设的决定性证据（复发时第一时间取）**：renderer 的 DevTools → Network。
  - 新请求显示 **Stalled / Queueing** ⇒ 连接池耗尽，假设成立。
  - 显示 **Pending** ⇒ 请求发出去了但服务端不回，是另一回事，往 sidecar 查。
  - `chrome://net-internals/#sockets` 可直接看槽位占用。
- 没有加回归测试：这两处在 Solid context 里、依赖 SDK 与 AbortController 时序，
  单测成本远高于收益。同族的「不变量没有闸门」问题已在
  `2026-08-21-subprocess-timeout-git.md` 记过一次（新增 `appProcess.run` 调用点忘传 timeout
  没人拦），此处同理：**新增 AbortController 的收尾路径忘了 abort 也没人拦**。
  仓里已有 `script/check-subprocess-timeout.ts` 这种源码级不变量闸门的先例，
  要做闸门的话按那个形状做。
