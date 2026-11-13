# GUI/TUI 改版第一、二阶段：朱印配色、阅读排版与署名粒度

状态:implemented（261113）

## 问题

RedCode 的外观一直跟着 `oc-2`（opencode 的默认主题）走，没有自己的视觉语言；消息流里
每个 part 都画一次 64px 头像，一长串工具调用像同一个人反复自我介绍。改版任务书要求
「朱印、人物署名、页边工作记录」这套语言，且明确不能另建一套平行主题框架。

## 决策

**主题落在 `redcode.json`，默认主题从 `oc-2` 切到 `redcode`。** 文件里的 `id` 同时从
`"opencode"` 改成 `"redcode"`，与文件名对齐。

**正文 15px / 165% 行高**，用 `calc(var(--font-size-base) + 1px)` 而不是固定 px——
`settings.appearance.fontSize` 的等比缩放写在 `--font-size-base` 上，固定值会让字号设置
对正文失效。标题与表格跟随，代码块（`.shiki`）保持 13px 单列调节。

**署名粒度 = 正文是边界**：工具/思考接着工具/思考才省略头像，正文出现即恢复。
GUI 用 `visibility: hidden` 保留 64px 占位（正文左边缘不跳），TUI 用 `parentID` 加
`agent/provider/model` 判定连续段并在有 text part 时恢复。中断与压缩分割线都是边界。

**工具记录用 1px `--border-weaker-base` 左边线 + 10px 缩进**，读成页边注记而不是气泡。

**TUI 侧栏次序**改为 上下文 100 → 配额 150 → 目标 200 → 待办 250 → 文件 300 →
MCP 400 → LSP 450。

## 备选与否决理由

- **改 `oc-2.json`**：它是上游同名主题，改值后每次合并上游都会冲突；「朱印」本来就是
  RedCode 自己的语言，不该挂在别人的名字下。代价是存量用户在 localStorage 里存过
  `oc-2` 的看不到新默认，只有没切过主题的人会看到——这是可接受的渐进。
- **整轮只署一次名**：首版这么做，一长串工具调用左侧空掉一整列、像没加载完。已废止。
- **把容器从 800px 收窄到 720px 实现 42–48 全角行宽**：会连带压窄 diff 与代码块。
  暂缓，待视觉验收后决定是否只约束正文段落。
- **capsule 折叠态挂异常红点**：任务书只写「异常可见」，没定义异常来源（工具失败 /
  MCP 掉线 / 构建失败）。没有依据前不实现，避免猜作者意图。

## 后果

- **配色 seed 不能直接填目标色。** `generateNeutralScale` 对深色走 `sink()` 二次压暗：
  `background-base = base.l * (1 - tone)`，`tone = clamp(0.19 + max(0, base.l-0.12)*0.33
  + base.c*1.95, 0.17, 0.27)`。seed 填 `#17191D`（L 0.213）实际出 `#0c0e11`；反解到
  L≈0.289（`#282b30`）才命中目标。浅色同理，目标 `#F1EFEA`（L 0.952）要 seed L≈0.945
  （`#f0ece7`）。改主题前先跑一遍解析探针，别对着 JSON 猜。
- 对比度已逐对计算：正常字号全部 ≥4.5:1；浅色 `text-weak` 收到 `#666d77`，
  深色品牌按钮改用深色文字（`text-on-brand-base: #1a1c20`，白字只有 2.9:1）。
- `oc-2` 保持上游原样，合并上游无冲突；新配色在 cream / green / deepblue 三个
  color-scheme 下未单独调（v1 token 跟主题、v2 色阶仍按 scheme 各自生成）。
- 视觉验收与 TUI 100×30 / 140×40 实测未做。

## 回链

- 任务书：`.redcode/docs/RedCode-UI-Redesign-Proposal.md`
- 代码：`packages/ui/src/theme/themes/redcode.json`、
  `packages/app/src/pages/session/message-timeline.data.ts`（`repeatSignature`）、
  `packages/ui/src/components/{markdown,message-part,session-turn}.css`、
  `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- commits：`463649a0`（1+2 阶段）、`134b29c4`（TUI 侧栏次序）
