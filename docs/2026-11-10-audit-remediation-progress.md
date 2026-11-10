# UI/UX 审计修复进度与接力（接力用）

日期：2026-11-10
来源：2026-11-09 会话对 UX-01 / 02 / 04 / 08 落地代码的交互审计（基线 `b23d10ec`）。审计原文是对话产出、仓库无存档，**本文收录全量条目**，后续接力以本文为准。
配套文档：UX 任务书进度看 `2026-11-09-ui-ux-progress.md`；harness 任务线（RC-01~07）看 `2026-11-09-harness-optimization-audit.md`。
2026-11-10 逐项核实结论：7 项（4 P1 + 3 P2）在 `b23d10ec..c22c11bc` 间**零修复**（相关文件整批未动），随后当日开始逐项收口。

## 审计条目与修复状态

| # | 级别 | 条目 | 位置 | 状态 | 修复提交 |
|---|---|---|---|---|---|
| A1 | P1 | Diff 已审查指纹只用增删行数，内容变化行数不变时标记误保留 | `packages/app/src/pages/session/review-progress.ts` | ✅ 已修 | `0f70e834` |
| A2 | P1 | Diff 上一/下一文件连点失效：step 只读 focusedFile 不回写 | `packages/ui/src/components/session-review.tsx` | ✅ 已修 | `e3a9b05e` |
| A3 | P1 | 布局预设双生命周期混写，按钮高亮与实际面板脱钩 | `packages/app/src/context/layout.tsx:846-858` | ⏸ **未修，等产品决策** | — |
| A4 | P1 | max_checks 静默截断仍报 passed，漏跑项无痕迹 | `packages/opencode/src/session/verification.ts` | ✅ 已修 | `107cffc6` |
| B1 | P2 | 状态台统计整个已加载会话，失败跨任务残留，无口径标注 | `session-activity-hud.tsx`（GUI）+ TUI `activity-hud.tsx` | 未修 | — |
| B2 | P2 | 新增组件字号钉死 11px 未接缩放 token | 预设按钮 + GUI 状态台 | ✅ 已修（点名两处） | `fbdf5117` |
| B3 | P2 | 状态台纯展示，无点击定位/跳转闭环 | `session-activity-hud.tsx:45-86` | 未修 | — |

同会话顺手完成（非审计项）：`c22c11bc` 设置面板提供 `verification.notice` 三选一开关（通用页，紧跟终端 Shell 行，desktop 内嵌同一 UI 自动生效）。

## 已修项实现要点（接力者免重读代码）

### A1 指纹（`0f70e834`）

- patch 存在 → 指纹 `patch:长度:FNV-1a32`（乘法必须 `Math.imul`，普通乘法 2^53 以上丢精度）；patch 缺失 → 回退旧 `status:增:删` 格式，旧行为不变。
- 升级后存量旧格式标记**一次性失效**（退回未审查），这是安全方向的失效。
- 测试 6 条：同计数不同内容失效 / 相同 patch 保留 / 旧计数与状态用例全保留。

### A2 导航（`e3a9b05e`）

- `SessionReviewProps` 新增 `onFocusedFileChange`；目标计算抽出纯函数 `stepTarget`（端点钳制不循环、焦点不在列表视同无焦点）。
- app 侧三层接线：`session.tsx` → `review-tab.tsx` → ui 组件；回写接到现成 `focusReviewDiff`，与文件树点击**同语义**（openPath + activeDiff + pendingDiff）——`pendingDiff` 的重试滚动（session.tsx:1059 起）覆盖目标 diff 未渲染、本地 `scrollIntoView` 落空的场景。
- **ui 包跑测试必须 `bun test --conditions browser ...`**，裸 `bun test` 在 kobalte 导入期就炸。

### A4 截断（`107cffc6`）

- 截断项以 `status: "skipped"`（reason `not run: max_checks limit (N)`）落进 `checks`——**复用权限拒绝路径的既有形状，Report schema 零改动**，`every(passed)` 判定自然降级 `partial`，失败项照常支配 `failed`。
- 默认 `notice: "failure"` 下 partial 报告不刷会话正文，但 `metadata.verification` 照落，下游可辨。
- 测试注意：**同 cwd + 同命令串会被去重合并**，测试里两条命令字符串必须不同（如 `bun pass.js` / `bun ./pass.js`）。
- commit 里有模型可见四问的完整回答（render 多一行、token 受 MAX_REPORT_BYTES=4096 约束、KV cache 不动）。

### B2 字号（`fbdf5117`）

- `text-[11px]` → `text-[length:var(--font-size-x-small)]`；两处行高本就是相对值（1.1 / 1.3）自动跟随。
- **默认档渲染 11px → 12px 是预期行为**（UX-08 已把 x-small 基准提到 12，随 `fontSize/14` 等比缩放），不是回归。
- **arbitrary class 编译失败是静默的**（typecheck / vite build 都不报错）→ 必须 `bun run build` 后 grep 产物 CSS 确认选择器真的生成了规则。
- 存量 6 处 `text-[11px]` 未动（属存量统一，需单独清扫）：`titlebar.tsx:435`、`settings-general.tsx:713`、`home-kanban.tsx:114,169,254`、`home.tsx:718`。

## 未修项开工上下文

### A3 布局预设（P1，**先拍板再动手**）

**决策点：「预设按会话恢复」还是「预设全局生效」**。现状两头混：

- 文件树开关（`layout.tsx:724`）、审查面板开关（`layout.tsx:832`）是**全局** store；预设名是**会话级** `sessionView.preset`（`layout.tsx:856`）；整个 store 持久化（`layout.tsx:296`）。
- 应用预设（`applyPreset`，`layout.tsx:846-858`）同时写两种生命周期 → 会话 A 选「专注」，切到先选过「开发」的会话 B，B 按钮仍显示「开发」但文件树实际延续 A 的隐藏。
- 手动开/关面板**不清 preset、无 custom 状态**（`fileTree.open/close/toggle`、`setReviewPanelOpened`、`setWorkbenchMode` 均不碰 preset）→ 手动调整后按钮高亮与实际布局脱钩。
- 按钮高亮取会话存储值而非实际布局（`session-layout-preset.tsx:41-45`）；全代码只有两处调用 `preset.apply`（按钮、命令面板 + `mod+1/2/3`），**没有「切会话时按会话重放预设」的逻辑**。
- 测试只有纯函数 `presetPlan` 形状断言（`layout-preset.test.ts` 5 条），无跨会话 / 重启恢复 / 手动调整用例。

两个方案的含义：
- **按会话恢复**：切会话时重放该会话存的预设（面板可见性改成会话级或加会话覆盖层）；改动面大，符合「每个会话一种工作模式」的直觉。
- **全局生效**：`preset` 提升为全局状态，切会话不复原；改动小，但丢「按会话记忆」。
- 无论哪个方案都需要：手动调整进入 custom / 清空 preset + 跨会话、重启恢复、手动调整后的回归测试。

### B1 统计口径（P2）

- GUI `session-activity-hud.tsx:21-24`、TUI `activity-hud.tsx:25-28` 都全量遍历已加载消息的 parts；`deriveActivity` 顺序累加，error part 永久留在 `counts.failed`，HUD 只要 >0 就持续显示——上一任务的失败会出现在下一任务的运行状态里。
- 「已加载范围内」的限定只写在代码注释里（`activity.ts:3-5`），用户不可见。
- 建议：口径改当前用户回合，或 UI 显式标注「本会话累计」；另补长会话重扫性能基准（任一 part 变化触发全列表重遍历）。

### B3 交互闭环（P2）

- GUI 纯 `<div>/<span>`（仅 `role="status"` + `aria-live`），grep onClick 为空；TUI 纯 `<box>/<text>` 无键鼠绑定。
- 建议最小闭环：点击当前文件名 → 定位 diff；点击失败数 → 跳到对应失败工具调用。不加复杂面板。

## 验证缺口（审计原文照录，均未补）

- GUI 1366 / 1920 / 2560 三档窗口截图对照（现有只有 1280×800）。
- TUI 80×24 / 120×36 / 180×50（重点 HUD 折行）。
- Agent 真实运行中的 HUD 截图（工具运行 / 失败 / 权限等待）。
- 壁纸遮罩真实视觉效果（0% / 18% / 60% 深浅壁纸）。
- 跨会话布局切换（Focus → Build → Review 循环）——A3 修复时一并补。
- Diff 连续导航真机交互链（Next ×3、Previous ×2）——A2 纯函数已测，真机未截。
- RC-05 检查数量截断真机验证（4 项预检、限制 3 项）——A4 单测已补。

## 运行验证方式

| 项 | 命令 |
|---|---|
| A1 指纹 | `cd packages/app && bun run test:one src/pages/session/review-progress.test.ts` |
| A2 导航 | `cd packages/ui && bun test --conditions browser src/components/session-review.test.ts` |
| A4 截断 | `cd packages/opencode && bun test test/session/verification.test.ts --timeout 30000` |
| B2 字号 | `cd packages/app && bun run build && grep -F 'font-size-x-small' dist/assets/*.css` |
| 设置开关 i18n | `cd packages/app && bun run test:one src/i18n/parity.test.ts` |
| 类型检查 | `packages/app`、`packages/ui`、`packages/opencode` 各自 `bun run typecheck` |
| 真机 GUI | `packages/opencode` 起 `bun run --conditions=browser ./src/index.ts serve --port 4097`，`packages/app` 起 `bun run dev`，打开 `http://localhost:5173`（networkidle 不会触发，用 domcontentloaded） |

## 本次修复提交（2026-11-10，自旧到新）

- `c22c11bc` feat(app): 设置面板提供交付验证报告显示时机开关
- `107cffc6` fix(session): max_checks 截断的检查以 skipped 落进报告，不再静默报 passed
- `0f70e834` fix(app): Diff 已审查指纹优先绑定 patch 内容哈希
- `e3a9b05e` fix(app,ui): Diff 上一/下一文件导航受控回写焦点
- `fbdf5117` fix(app): 布局预设按钮与状态台字号接入缩放 token
