# 双 SSE firehose 合流为单条，事件不再双份过主线程

状态:implemented

## 问题

`context/global-sdk.tsx` 与 `context/server-sdk.tsx` 各自维持一条到 `/global/event` 的 SSE 全量订阅（无事件类型/directory 过滤），两份代码 ~95% 同构（queue/16ms 合并 flush/part.updated 去重、心跳、指数退避、generation 守卫——注释都互相引用）。两个 Provider 常驻同时挂载，结果是：

- 每个事件**双份** JSON.parse、双份队列拷贝/合并、双份 emitter 遍历——流式期间持续性主线程税；payload 本身不小（`message.part.updated` 带完整 part，含 file part 的 base64 data URL）。
- 常驻占掉 Chromium 同 host 6 个 HTTP/1.1 连接中的 2 个（sidecar 是 node:http，无多路复用）——09-01 那次「槽位吃光、所有请求无限排队」的事故面里，双流让预算直接少三分之一。

## 决策

- **保留外层 global-sdk 的连接**，`server-sdk` 的 `event` API（on/listen/start/connection）整体代理过去。不改 app.tsx 的 Provider 顺序：GlobalSDKProvider 在外，`useGlobalSDK()` 在 server-sdk 里必然可用。
- 选 global 侧保连接的理由：260828 的修复要求它 onMount 自启动（通知/权限不依赖 server-sync 挂载）；server-sync 的 `event.start()` 调用透传且幂等，行为不变。
- `connection` 状态信号透传（唯一 UI 消费方 status-popover 读的就是 globalSDK 那份，代理兜住其他潜在读取者）。
- server-sdk 保留：url、client、createClient、createDirSdkContext（其 dir 级 re-emit 订阅共享 emitter，语义不变）。

## 备选与否决理由

- **反向合流（server 侧保连接）**：否决——需要把 ServerSDKProvider 挪到外层（改挂载顺序），且 server 侧连接由 server-sync 按需启动，通知的 260828 保证就得搬过去，动作更大。
- **两条都保留、只做事件过滤（查询参数裁剪）**：否决——治不了双份主线程税；且服务端事件过滤是另一个改动面，本 note 先把重复消掉。
- **合并成单一 Provider**：否决——global/server 两层的 client 生命周期与目录上下文管理各有职责，合并牵连太广。

## 后果

事件每份只 parse/派发一次，SSE 常驻连接 2→1（连接池多回一个槽位）。重连日志从此只有 `[global-sdk]` 一个来源。行为差异面：两流的独立重连节奏（各自退避计数）合并为一个——原本两条流断连时刻略有错开，现在同生同灭，对消费方不可见（本来事件就是双份投递）。`server-sdk` 文件从 ~345 行缩到 ~105 行。
