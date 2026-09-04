# 权限/提问弹窗点了没反应——pending 表按实例分，回复按 workspace 路由

状态：implemented

## 问题

隔离 worktree 里的子代理弹出授权框后，点 Allow once / Allow always / Reject 全无反应，
键盘也一样；按 esc 反而穿透到全局绑定把会话掐了。

服务端日志的签名很干净：

    INFO  service=permission id=per_… permission=external_directory patterns=["D:\AI\RedStudio\*"] asking
    DEBUG service=bus type=permission.asked publishing
    （此后没有任何 permission.replied）
    ERROR service=session.processor … error=Aborted process     ← 用户按 esc

**有 `asked` 没有 `replied`** 就是这一族的判据。

## 根因

`Permission` / `Question` 的 `pending` 表挂在 `InstanceState` 上，**按实例目录分桶**。

- 子代理在隔离 worktree 实例里 `ask()`，条目落在 **worktree 实例**的表里
- TUI/GUI 的回复按 **workspace** 路由（`WorkspaceRoutingMiddleware`）
- 而 `runIsolated`（`session/prompt.ts`）只 `provideService(InstanceRef, ctx)`，**不动
  `WorkspaceRef`** —— 隔离 worktree 与父目录**共享同一个 workspace，只有 directory 不同**

于是回复落到父实例，`pending.get(requestID)` 拿不到，一律 `NotFoundError`。而调用点长期是
`void sdk.client.permission.reply(...)`，不看返回、不 catch、不提示，失败得一声不吭。

**这个缺陷自 `1c3ba0cd`（2026-06-10，worktree 隔离上线）就潜伏着**，直到 09-03 16:28 第一次
被真正走到——那天起才开始用隔离子代理。`~/.redcode/data/worktree/` 下目录的创建时间是判断
「这条路径何时第一次被走到」最可靠的证据；查「什么时候开始出现的」别只翻代码改动史。

## 修法

模块级 `owners: Map<requestID, State>` 登记「这个请求属于哪份实例状态」：

- `ask()` 时登记
- `reply` / `reject`、中断的 `ensuring`、实例销毁的 finalizer 三处注销
- `reply` 在本实例找不到就按登记去拥有者那份状态里处理

⚠️ **先从拥有者的表里删再 resolve**，否则拥有者那边的 `ensuring` 会补发一条假的 reject。
`permission` 的「始终允许」也要记进拥有者的 `approved`。走到跨实例路径记一条
`reply routed to owning instance`，下次现场一行日志定案。

`question` 同形状同修（`locate()` 辅助函数）。

## 同一症状的另外两条路径（都是真缺陷，但不是这次的因）

这一族的固有特征是**症状同形、成因不同**。09-03 到 09-04 为它连修四次，前两次都对但都没修中：

1. **`e3dffe24` 回复原路发回 ask 的那个 workspace**——修的是「发错 workspace」那半边。对
   「同 workspace、不同实例目录」无效，因为隔离 worktree 恰好共享 workspace。
2. **`f0caa11e` 输入框抢回焦点**——弹窗期间输入框保持挂载（卸载会连正在打的字一起销毁），
   靠 `disabled` 触发 effect 让出焦点；但 `onMouseDown` 无条件 `focus()`，而那个 effect
   **不订阅 `input.focused`**，焦点被鼠标抢回去后它不再跑。弹窗按钮那排紧贴输入框上沿，
   点偏一行即命中。判据是日志里的 `prompt swallowed key while disabled`。
3. **`dcbf0e44` 中断留下的幽灵弹窗**——ask 方 fiber 被打断时只 `pending.delete` 不发
   `replied`，弹窗永远留在屏上，点它必然 NotFound。

**分诊顺序**：有 asked 无 replied → 查跨实例；有那条 warn → 查焦点；弹窗在会话已结束后还留着
→ 查幽灵。

## 两条方法论教训

- **「点击也不行」不能用来排除键位假设。** TUI 的权限选项挂了 `onMouseUp`，鼠标和键盘最终汇到
  同一个 `onSelect`。我曾拿这条去否掉键位层的假设，方向反了。
- **修完别急着在 commit 里写「根因」。** 前两次我都写了，事后都被证伪。判据没跑出来之前，
  写「同一症状的另一条路径」比写「根因」诚实。埋一条只有走该路径才会打的日志，比任何推断都值钱。

## 相关

- `packages/opencode/src/permission/index.ts`、`question/index.ts`（`owners` 登记）
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`（`mustYieldFocus()`）
- `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts`
- 冻结类 bug 那一族是**另一回事**（整个输入通道都死，不是只有弹窗死），别混诊。
