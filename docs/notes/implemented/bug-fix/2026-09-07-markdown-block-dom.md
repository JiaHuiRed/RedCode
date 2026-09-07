# 流式 markdown 渲染分块化：DOM 一步只付变化块的成本

状态:implemented

## 问题

`components/markdown.tsx` 的流式路径此前的每 tick 流程：块缓存命中的 HTML **join 成一个字符串** → 整篇 `temp.innerHTML = content`（全文重新 parse 成 DOM）→ `decorate` 全树 querySelectorAll 两次 → `morphdom(container, temp)` 全树 diff。260901 的分块缓存只省掉了 parse/sanitize，DOM 这三步仍与**已输出全文长度**成正比——30KB 回答每 tick 仅 DOM 一步就是毫秒级主线程占用，回答越长越卡。当时的注释自己写明「把每个块渲染进各自的子容器是下一步，风险更高，先不动」。

## 决策

- `createResource` 直接产出**块级 HTML 数组**（不再 join）。
- 每个块一个 `div[data-slot="markdown-block"]` 子容器，CSS `display: contents`——不生成盒，子元素 margin 直接与容器折叠，布局与「拼接 HTML」完全等价；markdown.css 其余规则全是后代选择器，包裹层无感（仓内外无任何对容器直接子结构的依赖，已 grep 确认）。
- 每 tick 只对 **HTML 变了的块** 跑 `innerHTML + decorate + morphdom(childrenOnly)`：`stream()` 保证已定型前缀块的 raw 恒定 ⇒ 缓存命中返回同一字符串引用 ⇒ 引用相等零成本跳过；真正变化的只有正在长的 settled 尾段与活跃尾块（≤2 个块）。块数增减按索引补齐/裁剪。
- morphdom 的 copy-button 状态保留 guard、`setupCodeCopy` 委托点击监听、DOMPurify 钩子全部原样保留——变化的是作用域（单块而非全树），不是语义。
- 块结构换轨（fence 两块 → 一般 N 块、流式 → 完成态单块）时索引错位，从错位点起全部重渲——一次性全量成本，与改动前相同，可接受。

## 备选与否决理由

- **保持整篇 morphdom，只调大 PacedMarkdown 节流间隔**：否决——把延迟转嫁给用户（打字机变卡顿跳变），且 O(全文) 的根本问题没动。
- **块间不包 div、用标记注释切分范围**：否决——morphdom 的 childrenOnly 语义建立在元素子节点上，注释切分要手写范围 diff，复杂度远超收益。
- **display: block 的普通包裹 div**：否决——会打断 margin 折叠与 `> *:first/last-child` 的语义，spacing 需要逐条补偿；display:contents 一条规则就保证等价。
- **上 DOM 测试框架（happy-dom + testing-library）做等价回归**：否决——ui 包测试全是纯逻辑测试，为一个组件引入整套 DOM 测试栈不成比例；分段→HTML 字符串的等价性已有 markdown-stream.test 的 13 例不变量覆盖，DOM 层靠语义推演 + stories 目测。

## 后果

流式期间每 tick 的 DOM 成本从 O(全文) 降到 O(活跃尾块)（≤2 块，通常 <4KB），与已输出长度解耦；已定型块的 DOM 完全不动（顺带保住了其中 copy-button 的瞬时状态）。新增一层无盒 div，DOM 树多 N 个节点（N=块数，长回答约 全文/4KB）。已知边界：display:contents 在极老浏览器有可访问性 bug（本产品 Chromium only，不受影响）；`stream()` 的「前缀块 raw 恒定」契约成为 DOM 增量渲染的正确性前提，该契约由 markdown-stream.test 的分段不变量测试锁定。
