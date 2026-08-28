# TUI 会话记录文本快照 + 缓存口径闸门

日期：2026-08-28 · 状态：implemented · 来源：deepseek-harness `snapshots/web/`（33 个场景的 ARIA 树快照）

## 问题

界面侧的测试比 0.09（GUI 91,085 行源码 / 7,753 行测试），DSH 的 client 是 0.77。但差距不在"写没写测试"，在**用什么方式写**：33K 行 `packages/ui` 要靠组件单测补到 0.75 得写两万多行，DSH 自己也没走那条路 —— 它的 0.77 是 33 个**整帧文本快照**堆出来的。

一份快照同时守住：DOM/布局结构、可见文案、token 计数口径、**缓存命中率**。写一个场景的成本 ≈ 跑一次真实会话。

本仓已经有这个技术（`test/cli/tui/inline-tool-wrap-snapshot.test.tsx`、CLI help 快照），但：

- 只有 1 个文件 4 例，全部关于 inline tool 行的换行；
- 那份里 `UserMessage` / `ShellOutput` 是**手写的替身**，只有 `InlineToolRow` 是真组件 —— 也就是说它主要在钉自己的 fixture；
- 状态数字（命中率、token）一个都没钉。

## 决策

分两半做，合起来才对应上游一份快照的覆盖面。

### 1. 整帧快照用**真**消息组件

`test/cli/tui/conversation-snapshot.test.tsx` 5 个场景，渲染的是 `routes/session/index.tsx` 里真正在跑的 `UserMessage` / `AssistantMessage`：单条用户消息、一轮问答、长文本按宽度折行（含 CJK）、多轮相邻间隔、助手消息带错误。

**harness 的关键取舍**（`test/cli/tui/lib/transcript.tsx`）：TUI 的 context 之间链式依赖 —— Theme 要 KV + TuiConfig，Local 要 Sync + SDK + Toast，后两个带副作用。渲染一条消息要把 7 层真 provider 立起来，而消息组件实际只读其中三五个字段。

所以给 `createSimpleContext` 加了一个 `context` 返回字段（原始 `createContext` 对象），测试直接喂假值绕过整条 init 链。`use()` 本身只是 `useContext(ctx)`，这条路是无损的。**Keymap 与 TuiConfig 仍用真 provider** —— `useCommandShortcut` 要从 keymap 查实际绑定，喂假值等于把"快捷键提示显示成什么"从快照里摘出去，而它就在消息行上。

fake 的性质值得记一笔：它不需要跟真类型逐字对齐，**缺字段或形状不对会在渲染时当场炸**，所以这份 fake 自己就是"消息组件到底读了什么"的清单。搭的过程里它连续报了四次，每次都指向一个我猜错的形状（`local.agent.color` 是函数不是常量、`useTheme()` 还返回 `syntax`、`syntax` 必须是真 `SyntaxStyle`、助手消息头要 `mode`）。

### 2. 缓存口径单独钉

`test/cli/tui/prompt-usage.test.ts` 10 例。`usePromptUsage` 是纯计算，不用渲染就能驱动，它编码的正是界面上那三档命中率（本轮 / 本次连接 / 会话全历史）与**冻结判据**。

冻结判据是重点：`连续 3 轮 read 完全不变且本轮未命中 > 3k`。08-04 那次前缀缓存被永久钉死（vision 临时文件名带 `Date.now()`，每轮改写一条历史消息）就是靠这组数字诊断出来的，而它此前零测试。用例覆盖真实冻结形态、read 还在长、未命中很小的空闲轮、只连续 2 轮不够、read 恒为 0 不误判。

## 备选与否决理由

- **渲染完整的 `Session()` 路由**：否决。要 7 层真 provider + SDK/Toast 的副作用，且路由自己带滚动/键盘状态，快照会被无关状态污染。
- **继续用手写替身**（既有那份的做法）：否决。那样钉的是 fixture 不是产品代码，改了 `UserMessage` 快照不会红。
- **截图比对**：不适用 TUI，且 GUI 侧也不该用 —— 字体渲染波动会假红，正解是 Playwright 的 `toMatchAriaSnapshot()`。
- **把状态数字也塞进整帧快照**（DSH 就是这么做的）：本轮否决。那要渲染 `component/prompt/index.tsx`（1800 行、圈复杂度极高的巨型组件），成本与收益不匹配；`usePromptUsage` 是它里面唯一独立的一块，单独钉已经拿到主要价值。

## 验证

`bun test test/cli/tui/` 134 pass / 0 fail（改动前 119，+15 即新增用例数），9 snapshots。`bun run typecheck` exit 0。

生成的快照确实有内容（空快照是最容易骗过自己的失败模式），含 CJK 折行、persona 名、`▣ Build · deepseek-v4-flash` 模型行、错误块的独立边框。

## 记账

- **未覆盖**：provider 自身的逻辑（主题解析、模型校验）；`Session()` 路由的滚动与键盘；`prompt/index.tsx` 的状态行渲染（数字口径已由 `prompt-usage.test.ts` 覆盖，渲染没有）。
- **GUI 侧仍是空的**：`packages/app/e2e/smoke/session-timeline.spec.ts` 是断言式（12 个 `expect`），零快照。对应形态是 Playwright `toMatchAriaSnapshot()`，成本比 TUI 高一档，未做。
- 场景数 5 对 DSH 的 33。往下加的顺序建议按"改动频率 × 回归代价"：工具调用行 → 压缩 checkpoint → 子代理回执 → 权限询问。
