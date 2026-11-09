# RedCode UI/UX 优化进度（接力用）

日期：2026-11-09
来源任务书：`RedCode UI / UX 高感知优化实施任务书`（UX-01 ~ UX-11）
原则：先做用户每天看得到、点得到的地方；不牺牲滚动/焦点/输入可靠性。

## 状态总表

| ID | 项目 | 状态 | 提交 / 证据 |
|---|---|---|---|
| UX-01 | 工作台三种布局预设 | 已完成 | `8b97f2b4`；`context/layout-preset.ts`、`components/session-layout-preset.tsx`；截图确认「开发」开树+工作台、「审查」落 Git 变更 |
| UX-02 | Agent 实时工作状态台 | 已完成（GUI + TUI） | `1314f577`；`composer/activity.ts` + `session-activity-hud.tsx`；TUI `routes/session/activity{,-hud}.tsx`；单测 6 + 4 条 |
| UX-03 | 对话时间线与工具视觉升级 | 未开始 | — |
| UX-04 | Diff 审查工作台增强 | 部分完成 | `76defb24`；已审查标记 + n/总数 + 上一/下一文件 + 指纹自动失效；筛选标签、审查汇总未做 |
| UX-05 | 新会话首页 | 未开始 | — |
| UX-06 | 输入框交互重排 | 未开始 | — |
| UX-07 | 侧边栏信息架构 | 未开始 | — |
| UX-08 | 视觉层级/字体/壁纸可读性 | 部分完成 | `79ea5699`；x-small 档纳入字号缩放（11→12 基准）、壁纸遮罩滑杆（0-60%，默认 18%）；面板层级统一未动 |
| UX-09 | 会话列表状态化 | 未开始 | — |
| UX-10 | TUI 高密度与上下文操作 | 未开始 | — |
| UX-11 | 微交互一致性 | 未开始 | — |

## 已落地实现的要点

- **布局预设**：只切面板可见性 / 工作台模式 / 默认标签，**不覆盖**用户拖过的宽度、滚动位置、文件标签；状态按会话持久化（`sessionView.preset`）；快捷键 `mod+1/2/3`，命令面板可搜。
- **活动状态台**：只读真实 tool part / session_status / permission / 子会话状态；不做百分比进度；失败单独计数；空闲自动隐藏。GUI 计数语义是「已加载消息范围内」，不得冒充整轮总数。
- **审查进度**：标记绑定 diff 指纹（status + additions + deletions），文件变化后旧标记自动失效；标记只表示「看过」，与暂存/测试无关。
- **可读性**：`--font-size-x-small` 之前漏在字号缩放之外，已补；壁纸遮罩写入整窗 CSS 变量 `--frost-alpha-veil`。

## 未验证项（not_run，别当成已通过）

- GUI 三档视口（1366×768 / 1920×1080 / 2560×1440）只截了 1280×800。
- TUI 80×24 / 120×36 / 180×50 布局未逐档验证；TUI HUD 只跑了单测 + typecheck，未截真机运行态。
- 状态台「运行中」实况未截图（需要真实模型回合，未为此烧 token）。
- 壁纸遮罩实际视觉效果未验证（当前配置未设壁纸，遮罩层不渲染）。

## 接力建议顺序

1. **UX-03**：在现有 `ContextToolGroup` / 工具折叠上做「探索 / 修改 / 命令 / 错误」分组摘要，保留失败与权限申请不被折叠吞掉；注意时间线虚拟化与滚动锚定回归。
2. **UX-06**：输入框上下文标签（`@` 引用、选区、附件）+ 一级/二级控制分层；注意 IME 与弹窗不抢焦点。
3. **UX-07**：TUI 窄终端（80 列）侧栏自适应与简要/完整两档；GUI 标签状态点。
4. UX-04 剩余：未审查筛选、审查完成后汇总、文件变化提示。
5. UX-05 / UX-09 / UX-10 / UX-11 按任务书第三阶段推进。

## 关键文件索引

- 布局：`packages/app/src/context/layout.tsx`（`view().preset` / `view().reviewed`）、`context/layout-preset.ts`
- 状态台：`packages/app/src/pages/session/composer/{activity.ts,session-activity-hud.tsx}`、`packages/opencode/src/cli/cmd/tui/routes/session/{activity.ts,activity-hud.tsx}`
- 审查：`packages/ui/src/components/session-review.tsx`、`packages/app/src/pages/session/review-progress.ts`
- 可读性：`packages/app/src/context/settings.tsx`（字号缩放/`wallpaperDim`）、`packages/app/src/components/settings-general.tsx`、`packages/app/src/pages/layout.tsx`（遮罩变量）

## 运行验证方式

- 单测：`cd packages/app && bun run test:one src/context/layout-preset.test.ts`（同理 activity / review-progress）；TUI：`cd packages/opencode && bun test test/cli/cmd/tui/activity.test.ts --timeout 30000`
- 类型检查：`packages/app`、`packages/ui`、`packages/opencode` 各自 `bun run typecheck`
- 真机 GUI：`packages/opencode` 起 `bun run --conditions=browser ./src/index.ts serve --port 4097`，`packages/app` 起 `bun run dev`，打开 `http://localhost:5173`（networkidle 不会触发，用 domcontentloaded）
