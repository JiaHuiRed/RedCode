# 钉住的目标终于有了界面

状态:implemented

## 背景

Goal 是这次清点里「后端整套在跑、前端一个字都没有」最极端的一例：

- `session/goal.ts` —— 独立 DB 表（session_id 主键）、五态状态机
  （active/done/cleared/blocked/budget_limited）、`tokens_used`、`turn_count`
- `session/prompt.ts:1638` —— 每轮把 `▸ ACTIVE GOAL` 注进系统提示
- `session/goal-continuation.ts` —— 按 token 预算自动续跑，三闸门（20 轮 / 30s 间隔 / 预算）
- `tool/goal.ts` —— `goal_set` / `goal_done` / `goal_clear`，且在 `registry.ts:305`
  是**无 flag 门控的默认工具**（旁边的 `task_status` / `repo_clone` / `lsp` / `plan` 全带 flag）
- `goal.updated` 总线事件已定义、SDK 类型已生成

`grep -ri goal` 打全 TUI + GUI + run 三个前端：零命中。模型钉了什么目标、烧了多少预算、
是不是已经 blocked，用户全看不见。

## 决策

### 1. 补一个 GET 端点，不只靠事件

`goal.updated` 已经在总线上，但只订阅事件的话：打开一个早就钉了目标的会话，在下一次
`goal.updated` 到达之前是空的。初始态必须能拉。

没钉目标时返 **404**，不返回一个 `status: "cleared"` 的空壳——「从没钉过」和「钉过又清掉」
在自动续跑那边是两回事（后者的 `turn_count`/`tokens_used` 仍在），用假对象抹平会让 UI 把
从没设过目标的会话画成「目标已清除」。

### 2. `Schema.Number` → `NonNegativeInt`

两个计数器原本是 `Schema.Number`。JSON 表示里 Number 允许 NaN/Infinity，codegen 于是把
`tokens_used` 摊成 `number | "NaN" | "Infinity" | "-Infinity"`，客户端每次读都得先判类型。
它们结构上就是非负整数（`tokens_used` 靠 SQL 累加、`turn_count` 每轮 +1），换成
`NonNegativeInt` 之后生成的是干净的 `number`。

### 3. 顺手修掉两处复制粘贴

`goal-continuation.ts` 里 `goal.tick(sessionID)` 连着调了两次。`tick` 是无条件
`turn_count + 1`（`goal.ts:142`），不是幂等的——**每次自动续跑把计数推进 2，
`MAX_GOAL_TURNS = 20` 实际只跑 10 轮就停**。21e1f71b 初次落地时就是两行。

同一段里 `goal.mark(sessionID, "budget_limited")` 也是两行，那个是幂等的（写同一个 status），
没有后果，一并收掉。

做面板时要显示「第 N/20 轮」，这个数必须先诚实——所以这两处不算越界，是同一件事的前提。

### 4. 轮次与预算只在自动续跑开启时显示

`goal_auto_continue` 默认是关的。关着的时候 20 轮上限与预算天花板**不会拦任何人**，
画一条「3/20 轮」的进度会让人以为有个并不存在的限制在逼近。

`tokens_used` 与这个开关无关——它在每轮 runLoop 结束时无条件累加（`prompt.ts:1924`），
任何时候都是「这个目标到目前为止烧了多少」，所以恒显示，只是开关关着时不带分母。

### 5. 位置：都贴着 Todo

`goal_set` 的工具说明里写着「Sub-tasks become todos」——目标与待办本来就是同一件事的两个
层级。TUI 放侧边栏 slot order 350（夹在 lsp 300 与 todo 400 之间），GUI 放 Plan 面板顶部。
`cleared` 两侧都不显示：目标被清掉之后这块就该消失，留一行「已清除」只是占地方。

## 后果

- 新端点 `GET /session/:sessionID/goal` → `Goal`。
- TUI：新增 `feature-plugins/sidebar/goal.tsx`；sync store 增 `goal` 字段、接 `goal.updated`
  事件、会话全量同步时一并拉取；插件 API 增 `state.session.goal(sessionID)`。
- GUI：Plan 面板顶部新增目标块；global-sync 的 State 增 `goal`、event-reducer 接
  `goal.updated`、directory-sync 增 `session.goal()` 拉取（蹭 todo 的同一个触发点）。
  `dropSessionCaches` 一并清理 `goal`，不留一处会随会话淘汰泄漏的键。
- 测试：`sidebar-goal.test.ts` 5 例（预算条定宽、端点、超预算钳制、预算为 0/负数不抛
  RangeError、负用量）；httpapi-exercise 新增 `session.goal` 场景（Goal 不在 AppLayer 里，
  种子路径单独补一层，不为测试改动生产接线）；`session-cache.test.ts` 补 goal 淘汰断言。
- 全量路由覆盖 153 pass / 0 missing；i18n parity 4 例通过；opencode / app / plugin 三个包
  tsc 干净；SDK 与 openapi.json 已重新生成。
- 两处既有失败与本次无关，已用「还原改动文件跑同一命令」核对过：`tui/sync.test.tsx` 的
  scope 断言、`app` 的 `bootstrap.test.ts` status 断言，基线上同样失败。
- 未做：目标的**编辑入口**。现在仍然只有模型能通过 `goal_set` 钉，用户不能在界面上直接
  改或清。加一个输入框是另一件事（要想清楚用户改目标与模型改目标冲突时谁赢），不混在这次。
