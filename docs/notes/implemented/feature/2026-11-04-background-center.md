# 后台活动中心（TUI 阶段一）

状态:implemented（TUI 阶段 + GUI 只读批次；GUI 终止与持久化待做）

## 问题

十天前启动的遗留后台进程直到手动排查才被发现，用户需要一个「现在到底还跑着什么」的入口。现有登记分散且都不可见：

- `BackgroundJob`（`src/background/job.ts`）：内存态，`task_status` 工具只能按 id 查，面板不可见；完成态保留 30 分钟 / 最多 50 条。
- PTY 终端（`src/pty/index.ts`）：另一套登记，PID 在 `Info` 里，但 TUI 没有入口，终止会走 `taskkill /f /t` 整树。
- 外部进程（例如十天前那个 bash）：不属于任何 RedCode 登记，无法被认领。

## 决策

1. 新增 `GET /background`：返回 `BackgroundJob` 的定位与状态字段（id/type/title/status/startedAt/completedAt/error/sessionID/parentSessionID），**不返回 output**——子代理完整输出可达数 MB，列表接口不能把它带上。
2. 新增 `POST /background/{jobID}/cancel`：走 `cancelTree`，连同嵌套子任务一起中断；幂等，任务不存在返回 `{ cancelled: [] }`，不引入 404 契约。
3. TUI 入口两层：输入框模型行右侧常驻「后台」按钮（有运行中任务时 `● 后台 N` 并高亮，10 秒轮询一次列表；服务端没有该路由时静默退回无计数），点击直接打开面板；`ctrl+x j`（命令 `/background`）作为键盘入口保留。面板把后台任务与 PTY 终端放进同一张表，显示状态、类型、运行时长、PID/工作区；打开时两秒轮询，运行中的条目二次确认后终止（任务走新接口，终端走既有 `pty.remove`）。
4. 只展示 RedCode 登记过的活动，不扫描系统进程、不给外部进程编造归属——面板不冒充进程管理器。
5. `groups/background.ts` 在 `api.ts` 里必须最后 import：它经 `instance-context → project/instance-store` 拉链，若在 permission/session 初始化环之前求值，会命中 `session.ts` 顶层的 `Permission.Ruleset` TDZ（`Cannot access 'Ruleset' before initialization`，httpapi exercise 全红）。

## 后果

- 重启后历史丢失（`BackgroundJob` 是内存态），面板只反映当前进程登记的活动；持久化与「重启后对账孤儿」留到下一阶段。
- 列表不含输出详情；需要看输出时仍走会话记录。后续可加 detail 端点，但必须带字节上限。
- GUI 复用同一接口即可，不需要新的服务端契约。

## GUI 第一批（261104）

- 入口与 TUI 对齐：输入框底栏在上下文指示器后加「后台」按钮，运行中显示橙点 + 数量（10 秒轮询；服务端无该路由时静默）。
- 面板（`app/src/components/background-activity.tsx`）：一张表列后台任务与 PTY（状态/时长/PID/工作区），两秒轮询；点任务行跳转对应会话。
- 本批**只读**：终止动作（`POST cancel` / `pty.remove`）留到第二批，配二次确认。
- 已知边界：宠物浮层（`z-index: 40`）在当前窗口高度下会压住输入框底栏右侧，连原有的上下文数字一起被压；这是既有布局问题，与本功能无关，需要时另修。

## 验证

- httpapi：coverage / auth 各 172 pass（含 `background.list`、`background.cancel` 两条场景）。
- 定向：`--mode effect --include background` 2 pass。
- `bun run typecheck` exit 0；`check:openapi-drift` 通过（SDK 与 openapi 同步重生成）。
- GUI：`packages/app` typecheck exit 0、i18n parity 4 pass；浏览器实测「后台」按钮 → 空态 → 临时 PTY 出现后计数与列表正确，清理后恢复为空。
