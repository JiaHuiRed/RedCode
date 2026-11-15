# RedCode UI/UX 接力总清单

最后更新：2026-11-15。本文件合并两份 UX 清单，是 A 线的权威进度记录。

## 两份来源、两套 UX 编号（引用时必须带前缀）

| 线 | 来源 | 编号 | 交付状态 |
|---|---|---|---|
| **A** | 2026-11-09《RedCode UI / UX 高感知优化实施任务书》（原文不在仓库，以本文档为权威记录） | UX-01 ~ UX-11 | 分阶段推进，仍有剩余 |
| **B** | 2026-11-14《体验优先审查》`docs/2026-11-14-experience-review-0.18.4-0.18.5.md` | UX-01 ~ UX-20 | 0.18.4 十二项 + 0.18.5 八项，**全部落地** |

**A-UX-01 和 B-UX-01 不是同一件事。** 两套编号都从 UX-01 起，内容完全不同。2026-11-14 之后的 commit 与 CHANGELOG 里的 `UX-xx` 一律指 B 线；本文档提到 A 线时写 `A-UX-xx`。

## A 线状态（2026-11-15 按现行代码复核）

| ID | 项目 | 状态 | 现行证据 |
|---|---|---|---|
| A-UX-01 | 工作台三种布局预设 | 已完成 | `8b97f2b4`；`context/layout-preset.ts`、`components/session-layout-preset.tsx` |
| A-UX-02 | Agent 实时工作状态台 | 已完成（GUI + TUI） | `1314f577`；`composer/activity.ts` + `session-activity-hud.tsx`；TUI `activity{,-hud}.tsx` |
| A-UX-03 | 对话时间线与工具视觉升级：探索/修改/命令/错误分组摘要 | 已完成（261115） | `message-part-groups.ts` + `ToolGroup`：三类分段折叠；组内失败自动展开并标红失败数 |
| A-UX-04 | Diff 审查工作台增强 | 部分完成 | 已审查标记 + n/总数 + 上一/下一 + 指纹失效（`0f70e834`/`e3a9b05e`）；B-UX-16 补了未审筛选与「标记并下一个」；**「审查完成汇总」仍未做** |
| A-UX-05 | 新会话首页 | 部分覆盖 | B-UX-03/05/07 做了快选 Soul 与工具栏；A 线原定的首页信息架构（项目/最近/快捷入口）未按原文核对 |
| A-UX-06 | 输入框交互重排 | 部分覆盖 | B-UX-06 长提示展开编辑、B-UX-07 工具栏自适应与字号 token 已落地；A 线要求的「一级/二级动作分层」未做 |
| A-UX-07 | 侧边栏信息架构 | 部分覆盖 | B-UX-09 做了多会话找回；TUI 窄终端两档、GUI 标签状态点未按原文核对 |
| A-UX-08 | 视觉层级/字体/壁纸可读性 | 部分完成 | 字号缩放 + 壁纸遮罩滑杆；**「面板层级统一」未动** |
| A-UX-09 | 会话列表状态化 | 已完成 | `pages/home.tsx` 的 `HomeProjectStatus` / `statusLabel`：working/permission/error/unseen 四态带文案 |
| A-UX-10 | TUI 高密度与上下文操作 | 待复核 | 无现行实现点可对照，需按任务书原文核对 |
| A-UX-11 | 微交互一致性 | 待复核 | 无统一判据，需按任务书原文核对 |

## B 线：11-14 体验审查 20 项全落地

| 版本 | 编号 | 主题 |
|---|---|---|
| 0.18.4 | B-UX-01/02/12 | 设置窗口可调大小/最大化、新建 Soul 默认收起、终端一键最大化 |
| 0.18.4 | B-UX-03/04 | 新会话快选 Soul、Soul 阵容详情工作区 |
| 0.18.4 | B-UX-05 | 模型名直开列表 |
| 0.18.4 | B-UX-06/07 | 长提示拖高与展开编辑、工具栏自适应换行（字号走 token） |
| 0.18.4 | B-UX-08 | 设置跨分区搜索、MCP/服务商编辑回原列表 |
| 0.18.4 | B-UX-09/10/11 | 多会话找回与首页位置保留、工作位置真实生效、状态台可点击定位 |
| 0.18.5 | B-UX-13~20 | Soul 全流程、Agent 说明、会话全文搜索、Diff 连续审阅、后台成果回收、文件预览 tab、按需加载、外观实时样例 |

逐项验收场景与源码定位见报告原文；落地证据见 `CHANGELOG.md` 的 `[0.18.4]`、`[0.18.5]` 两段。

## 真实剩余（按推进顺序）

1. **A-UX-04 剩余：审查完成汇总** —— 全批审完后给一行真实汇总（改了哪些文件、审了几个），接在 B-UX-16 的收尾状态后面。
2. **A-UX-06 剩余：输入框控制分层** —— 一级动作（发送/停止/模型/Agent/Soul）与二级动作（附件、上下文、更多）按层级排布，而非只做换行。
3. **A-UX-07 侧边栏信息架构** —— TUI 80 列两档 + GUI 标签状态点。
4. **A-UX-08 剩余：面板层级统一**。
5. **A-UX-05 新会话首页** —— 按 A 线原文核对并补齐。
6. **A-UX-10 / A-UX-11** —— 需先找回任务书原文再核对，暂不动工。

已完成：A-UX-01、A-UX-02、A-UX-03（261115 工具分组摘要）、A-UX-09。

## 运行验证方式

- 单测：`cd packages/app && bun run test:one <file>`；`cd packages/ui && bun run test:one <file>`
- 类型检查：`packages/app`、`packages/ui`、`packages/opencode` 各自 `bun run typecheck`
- 真机 GUI：`packages/opencode` 起 `bun run --conditions=browser ./src/index.ts serve --port 4097`，`packages/app` 起 `bun run dev`，打开 `http://localhost:5173`（networkidle 不会触发，用 domcontentloaded）

## 已落地实现的要点

- **布局预设**：只切面板可见性 / 工作台模式 / 默认标签，不覆盖用户拖过的宽度、滚动位置、文件标签；状态按会话持久化（`sessionView.preset`）；快捷键 `mod+1/2/3`。
- **活动状态台**：只读真实 tool part / session_status / permission / 子会话状态；不做百分比进度；失败单独计数；空闲自动隐藏。
- **审查进度**：标记绑定 diff 指纹（`patch:长度:FNV-1a32`），内容变化即失效；标记只表示「看过」，与暂存/测试无关。
- **可读性**：`--font-size-x-small` 纳入字号缩放；壁纸遮罩写入整窗 CSS 变量 `--frost-alpha-veil`。

## 历史未验证项（保留原文，别当成已通过）

- GUI 三档视口（1366×768 / 1920×1080 / 2560×1440）只截了 1280×800。
- TUI 80×24 / 120×36 / 180×50 布局未逐档验证；TUI HUD 只跑了单测 + typecheck。
- 壁纸遮罩在未设壁纸时不渲染，视觉效果未验证。

## 关键文件索引

- 布局：`packages/app/src/context/layout.tsx`、`context/layout-preset.ts`
- 状态台：`packages/app/src/pages/session/composer/{activity.ts,session-activity-hud.tsx}`、TUI `routes/session/activity{,-hud}.tsx`
- 审查：`packages/ui/src/components/session-review.tsx`、`packages/app/src/pages/session/review-progress.ts`
- 工具渲染：`packages/ui/src/components/message-part.tsx`（`ContextToolGroup` 在 907 行）
- 可读性：`packages/app/src/context/settings.tsx`、`components/settings-general.tsx`
