# 轮次目录的事件失效通道

状态:implemented

## 问题

会话左侧消息轨道（`SessionMessageRail`）与右栏「轮次」标签共用 `GET /session/:id/outline` 的
查询缓存。实测在长时间打开的窗口里，轨道只列出**会话打开那一刻**存在的用户轮次，此后无论
用户发了多少条都不再变化：exe 12:25 启动、12:30 打开该会话时正好两条用户消息，于是轨道永远
只有两条，点击也只在有限范围内跳转。

## 根因

`bootstrap.ts` 的 `loadSessionOutlineQuery` 注释写着「故意不带 staleTime —— 目录随每一轮增长，
而新一轮的落地由事件流驱动，界面上的失效点在 message.updated（见 server-sync.tsx 的 invalidate）」。
但 `server-sync.tsx` 里全部 `invalidateQueries` 只有三处，全是 provider / providerCatalog 相关，
**指向 outline 的那条通道从未接上**。

叠加 `app.tsx` 的 `refetchOnMount: false` 与 `refetchOnWindowFocus: false`：只要轨道组件一直挂着
不卸载，这个查询既不会被判定过期（无 staleTime 时默认 stale，但没人触发重取），也不会在重新
挂载或窗口聚焦时重取，于是永久停在首次响应的快照上。

对照实验（隔离栈，新建空会话后保持页面不动）：

- 停用失效通道：服务端灌入两条用户消息，页面 `user-message` 正常渲染 2 条，但轨道不出现、tick 数 0
- 启用失效通道：同样流程，轨道自行出现、tick 数 2

两条路径跑在同一页面、同一会话上，排除「别处本来就会刷新」的可能。

## 决策

在 `serverSDK.event.listen` 的目录分支里补上这条通道：`message.updated` 且角色为 `user` 时，
失效 `[directoryKey(directory), "sessionOutline", sessionID]`。

只认 user 角色。轮次由 user 消息定义（见 `session/outline.ts` 的锚点口径：一轮 = 一条 user 消息
及其后到下一条 user 之间的 assistant 消息），assistant 消息只改同一轮的 `response` 预览，属于
次要信息，不值得为流式期间每条消息都挂一次失效。

## 备选与否决理由

- **给查询加 staleTime / refetchInterval**：否决 —— `bootstrap.ts` 该处的注释已经否决过：staleTime
  会让刚发的那条在导航栏里迟到；refetchInterval 则在会话空闲时也持续产生请求。
- **`refetchOnMount: "always"`**：否决 —— 全局开着 `refetchOnMount: false` 是有理由的；而且它治不了
  本问题的主要形态：常驻不卸载的轨道根本不会再挂载一次。
- **在 event-reducer 里触发失效**：否决 —— 那里是纯 store 归约，不该有请求副作用。
- **对每条 `message.part.updated` 都失效**：否决 —— 流式期间这是最高频的事件，会把目录查询变成
  每个 delta 一次。

## 后果

轨道与「轮次」标签在用户发言落地后立即跟上，目录请求频率退化为「每次用户发言一次」。
首次打开会话时仍是一次请求（与改动前一致）。
