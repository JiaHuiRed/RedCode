# `@` 菜单：陈旧候选只能看不能选

日期：2026-09-01 · 状态：implemented · 来源：deepseek-harness `.agents/notes/implemented/bug-fix/2026-08-28-trigger-menu-stale-while-revalidate.md`

## 问题

上游那篇是两半：

1. **显示侧** —— 他们的菜单 reducer 在每次按键的 `hit` 分支把各组重置为 pending-空，于是列表在 100–460ms 的请求往返期间塌缩成骨架屏，每输入一个字符就重绘一次。改成保留上一次的行与高亮（stale-while-revalidate）。
2. **正确性侧** —— 保留陈旧行之后，`pick()` 必须要求该组已 `ready`，Enter 在 pending 窗口里是显式空操作，既不选中陈旧行、也不漏成"提交草稿"。

回本仓核实：**第一半我们本来就有，第二半没有。**

`packages/ui/src/hooks/use-filtered-list.tsx` 的 `flat` 读的是 **`grouped.latest`** 而不是 `grouped()` —— `createResource` 的 `.latest` 在新一轮 fetch 在途时返回上一次已解析的值，正是 stale-while-revalidate。`slash-popover.tsx` 里也确实没有任何 loading / 骨架屏分支。所以列表不会塌。

但 Enter 分支没有任何在途判断：

```ts
if (event.key === "Enter" && !event.isComposing) {
  event.preventDefault()
  const selectedIndex = flat().findIndex((x) => props.key(x) === list.active())
  const selected = flat()[selectedIndex]
  if (selected) props.onSelect?.(selected, selectedIndex)
}
```

`@` 那个列表的 `items` 是 `async (query) => { … await files.searchFilesAndDirectories(query) }`，**没有防抖**，每个按键都发一次 HTTP 搜索。于是：敲 `@src/comp` 时高亮在 `src/components/app.tsx`，接着快速敲完 `onents/prompt` 并回车 —— 若最后一轮查询还没落地，插进去的是 `src/components/app.tsx`，一个用户没挑过的候选，而且**静默**。

`createEffect(on(grouped, () => reset()))` 让这件事更明确：结果一落地高亮就重置到新列表的第一项，也就是说 pending 窗口里那个高亮**注定**和用户 settle 后会看到的不是同一个。

## 决策

两处设闸，因为 Enter 和 Tab 走的是不同的路：

- **Enter** 在 `use-filtered-list.tsx` 的 `onKeyDown` 里判 `grouped.loading`。返回不会漏成提交草稿 —— `prompt-input.tsx` 的 keydown 分发在 popover 打开时对 Enter 一律 `preventDefault()` 后 `return`，"消费掉"这个结构本来就在。
- **Tab** 走 `prompt-input.tsx` 的 `selectPopoverActive()`，绕过 hook，所以要单独判一次。hook 因此多导出一个 `loading()`。

`/` 菜单的 `items` 是同步数组，`loading` 基本恒假，这道闸实际只对 `@` 生效。

**刻意不给"加载中"的视觉反馈。** 陈旧行本来就是对的样子（这正是 stale-while-revalidate 的意义），而按键级的明暗切换会变成逐字符闪动 —— 那是明确不要的东西。代价是快打时可能吞掉一次 Enter，再按一次即可；不设闸的代价是静默插入一个错的文件。

## 顺带修掉的：`packages/ui` 的测试在用 solid 的服务端构建

给这条写回归测试时才发现：`bun test` 默认按 node 条件解析，`solid-js` 因此落到 `dist/server.js`，`createResource` 在那里直接抛 `getNextContextId cannot be used under non-hydrating context`。

既有 7 个测试文件全是纯逻辑，碰不到响应式，所以这件事一直没暴露。**但 `packages/ui` 是浏览器 UI 包，它的测试解析到服务端构建本来就是错的**，不只是挡住了这一个测试。`package.json` 的 `test` 与 `test:ci` 都加上 `--conditions browser`。

做过对照：不带 flag 是 38 pass / 2 fail（新加的两个），带上是 40 pass / 0 fail —— 既有测试零影响。

## 测试

`packages/ui/src/hooks/use-filtered-list.test.ts`，2 例，用 `createRoot` 起响应式作用域（hook 不渲染 DOM，不需要 happy-dom）：

1. 受控 promise 卡住第二轮查询 → 断言此时 `flat()` 仍是上一轮结果、`loading()` 为真、**Enter 不触发 `onSelect`**；放行 promise 后 `flat()` 换新、Enter 正常选中。
2. 同步 `items` 数组不受影响，Enter 立即生效。
