# GUI 上下文窗口：口径修复 + 指示器挪到模型显示旁

状态:implemented

## 问题

哥哥看到 Claude Code 里模型名旁边那个小进度圈，问 GUI 能不能也加一个。查下来 **GUI 早就有这套东西**——`session-context-usage.tsx` 就是一个带 `ProgressCircle` 的按钮，点开 436 行的 `session-context-tab.tsx` 分解面板（system/user/assistant/tool/other 分色）。两个变体也都挂着：timeline 顶栏（button）、侧栏（indicator）。

真正的问题是**那个数是错的**，而且比 TUI 那处更离谱。`session-context-metrics.ts`：

```ts
// Aggregate across all assistant messages (not just the last one)
for (const m of messages) { agg.input += …; agg.cacheRead += … }
const total = agg.input + agg.output + agg.reasoning + agg.cacheRead + agg.cacheWrite
usage: limit ? Math.round((total / limit) * 100) : null
```

`total` 是**整个会话累计**（注释写得很明白，对缓存命中率那些字段来说这口径是对的），但 `usage` 拿它除上下文窗口。哥哥截图里那个会话累计 15,416,562、窗口 1M —— `usage` = **1542%**。

而 `ProgressCircle` 内部 `Math.max(0, Math.min(100, …))` 钳到 [0,100]，所以**那个圈从会话累计超过一个窗口起就永远是满的、再没变过**。tooltip 里并排显示的 `total` 与 `usage%` 两个数，正是哥哥一开始误把「会话累计」当成「上下文窗口」的直接来源。

## 决策

**只改 `usage` 的分子，不动 `total`。** `总 Token` 那行标签本来就对（它就是累计），缓存命中率、逐轮 read/bad 序列、stalled 判据也都依赖这个累计口径，动它会牵连一大片。

新增 `window = message.tokens.context`（今日 `9b45c01` 加的字段：最后一条 assistant 那一刻的提示词总量，`processor` 里覆盖不累加），`usage = window / limit`。历史消息没有该字段 → `window` undefined、`usage` null，UI 侧整块不显示，等下一轮请求写入——比拿个已知错的数糊上去诚实。

**位置**：控件行本来就是 `agentControl | modelControl | variantControl`，与截图里 `Opus 5 | Max ◐` 的排布一致，把同一个 `SessionContextUsage` 挂在 `variantControl` 之后即可。不需要新组件——它自带 `<Show when={params.id}>`，新建会话页没有 id 时整块不渲染；依赖的 `useSessionLayout` 只用 `useParams()` + `useLayout()`，在路由树任意位置都安全。

tooltip 拆成两行（上下文窗口 `40k / 100k · 40%` 与会话累计），面板里也补一行「上下文窗口」。

## 备选与否决理由

- **新写一个轻量指示器**：否决——现成组件功能完全够，重写只会多一份要同步维护的口径。
- **把 `total` 直接改成真实上下文**：否决——`total` 喂着缓存命中率与 stalled 判据，那些确实要累计口径。
- **`window` 缺失时回落到 `total`**：否决——那正是要修掉的错值，回落等于把 bug 留在历史会话上。

## 后果

- 测试：`session-context-metrics.test.ts` 新增 3 例（usage 用 tokens.context 不随累计涨 / 无 context 字段时 window+usage 为空 / 无窗口数时 window 仍给出而 usage 为空）；**一条既有用例按新口径更新**——它原本断言 `usage === 50`，即 `total(500)/limit(1000)`，正是被修掉的语义。
- app 全量单测：基线 345 pass / 6 fail → 改后 348 pass / 6 fail，失败集合逐条一致（auth/bootstrap/websocket/theme 四类既有失败，与本次无关）。
- i18n 三语补 `context.usage.window`（仓库只维护 en/zh/ja）。
- 与 TUI 那处（`2026-08-19-context-window-sidebar.md`）是同一个坑的两端：TUI 用的是跨 step 累加的 `tokens.total`，GUI 用的是跨消息累加的会话总量。两处都改用 `tokens.context`。
