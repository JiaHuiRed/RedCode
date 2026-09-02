# 轮次导航栏：整份日志的目录 + 翻页跳转

日期：2026-09-01 · 状态：implemented · 来源：deepseek-harness `.agents/notes/implemented/feature/2026-08-30-web-turn-rail-outline-jump.md`

## 问题

上游那篇的问题陈述对本仓逐字成立：**导航如果从已加载的消息窗口推导，而窗口只是日志的一个分页后缀，那么长会话里导航只会列出最近几轮 —— 恰恰是不需要导航也看得到的那部分。**

本仓的窗口是 `initialMessagePageSize = 40` 起步，往前靠「加载更早」一页页翻。现有的轮次导航只有 `session-message-nav.ts` 的前后跳，而它收的是 `UserMessage` **对象**，也就是说只在已加载的那些轮次之间走。实测他库里最长的会话 2612 条消息 / **379 轮**，首屏只覆盖其中最后几轮。

## 决策

三块，各自独立可用。

### 1. 数据：`GET /session/:sessionID/outline`

`session/outline.ts` 直接查库，与消息窗口无关。轮次的定义与时间线一致（`message-timeline.data.ts` 的 `constructMessageRows`）：一条 user 消息 + 它之后到下一条 user 之前的全部 assistant。锚点取 user 消息 id —— 它同时是跳转目标和该轮在时间线上的第一行。

与上游的两点不同：

- **不做投影折叠。** 上游是事件溯源，目录是注册在 `ctx.sessionProjections` 上的纯 fold，还要配一套「变更源身份闸门」把流式期间每条 assistant 消息的推送压到每轮三次。本仓是 SQLite，直接查表就有全量，那套增量机制没有对应物。
- **预览在 SQL 里先截断。** 长会话正文可以有几 MB，目录每轮只要一两行。`substr(json_extract(...), 1, 400)` 让截断发生在数据库里。另外 part 表按 `group by message_id` + `min(id)` 压成每条消息一行（SQLite 有明文保证的裸列取值写法），否则一个长会话要拉几千行回来只为每条消息的头几十个字。

回答预览取**这一轮最后一条带文字的** assistant 消息，与上游「最新的 text-bearing assistant 在 turn/end 落定」同一口径。

### 2. 跳转：`historyLoader.loadThrough(messageID)`

上游是 `Session.loadThrough(seq)` 按 seq 算页；本仓的分页游标是消息 id，判据换成「目标是否已进 `visibleUserMessages`」—— 目录锚点就是 user 消息 id，两边天然对齐。

三个终止条件缺一不可：

1. `historyMore()` 为假 —— 翻到底了，目标不在这个会话里（或已被压缩掉）。
2. **无进展**（翻了一页 `loaded()` 没涨）时**不当场放弃，而是等一拍再试**。`directory-sync` 的 `loadMessages` 对并发调用是静默 no-op（`if (meta.loading[key]) return`），所以「没进展」最常见的原因是用户同时往上滚触发了另一次翻页、pager 被占着。上游那条 `fix(ui-chat): hold jumps while a plain pull owns the pager` 修的正是这种情况下跳转退化成「落在最近一条」。连续 8 次都没进展才算真的空页。
3. 页数上限，纯兜底。

翻到之后滚动放在 `requestAnimationFrame` 里：prepend 刚插进来的行还没被 virtua 测量，同一拍里 `scrollToIndex` 用的是估算尺寸（`message-timeline.tsx` 那条注释记过这个坑）。翻不到就 toast 明说，不静默。

### 3. UI：右侧面板新增「轮次」标签

**不另起一个面板。** 会话页右侧已有 review / context / status / plan 四个标签，加第五个能复用现成的外壳、宽度、磨砂样式与开关方式。数据与跳转留在 `session.tsx`（那里才有 `loadThrough` 与 `revealMessage`），面板只收一个 `outlinePanel: () => JSX.Element` 槽，与既有的 `reviewPanel` 同形。

标签内容包在 `<Show when={activeTab() === "outline"}>` 里，于是**目录请求只在真的打开这个标签时才发** —— 不给「点开会话」那条今天刚优化过的热路径再加一次往返。取数容器里先判 `isLoading` 再读 `data`：pending 时读 `.data` 会挂起，一路冒到 `app.tsx` ConnectionGate 那个 fallback 是满屏 Splash 的 Suspense（今天上午刚踩过一次）。

最新一轮排在最上面 —— 长会话里要找的通常是刚才那几轮。

## 实测

拿他真实的库跑只读探针（`~/.local/share/redcode/redcode.db`，最长会话 `ses_17a46507fffe…`）：

| | |
|---|---|
| 消息 | 2612 条 |
| part 表命中行 | 1418（已压成每消息一行） |
| 轮次 | 379 |
| 两条 SQL | 414ms |
| 载荷 | 107.2KB |
| 无回答的轮次 | 11 |
| 无提问文字的轮次 | 7（压缩标记那类） |

414ms 是**库里最长的那个会话**、且只在打开标签时发一次、之后走 query 缓存，可接受。真要再快，得给 `json_extract(data,'$.type')` 建表达式索引，那是一次迁移，不值得为这个功能做。

## 测试

`packages/opencode/test/session/outline.test.ts`，7 例。折叠逻辑抽成纯函数 `fold(sessionID, rows, text)` 与库解耦 —— 轮次编号、「最后一条带文字的 assistant 才算回答」、孤儿 assistant 不造轮次（历史被压缩时第一条可能就是 assistant，凭空造一轮会让导航栏出现一条点不动的行）、截断按码点不按码元（emoji 是代理对）、空会话不抛。这几条都只跟折叠有关、不跟 SQL 有关。

SQL 本身由上面那次真实库探针背书。

## 未做

- **界面没有视觉验证。** 起 desktop dev server 在这台 16GB 的机器上曾把内存打到 2.9GB，没有在未打招呼的情况下再起一次。标签页的排版需要他自己看一眼。
- 目录**不随流式实时增长**：新一轮要等 query 重新拉取才出现在导航栏里。上游用「变更源身份闸门」把推送压到每轮三次来解决，本仓没有那层。真要做，最省的路是在会话 status 转 idle 时 invalidate 一次这个 query，而不是把预览计算在前端再实现一份（上游明确提醒过：目录预览与已加载轮次的预览必须同一口径，否则同一轮在加载前后显示的字不一样）。
