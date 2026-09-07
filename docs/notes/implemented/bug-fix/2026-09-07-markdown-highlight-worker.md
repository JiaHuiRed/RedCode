# markdown 代码块高亮迁专用 worker 池，主线程只分派不计算

状态:implemented

## 问题

`context/marked.tsx` 的 `highlightCodeBlocks` 用 `getSharedHighlighter`（pierre 的**主线程** highlighter）逐块同步 `codeToHtml`。260811 已把流式期间的高亮跳过（`highlight:false`），但最终渲染和工具输出（`<Markdown>`）仍全量走主线程：长会话滚动时，markdown.tsx 块缓存（LRU 200）未命中的代码块逐个在 UI 线程跑 shiki——这是「翻历史消息卡一下」的主力。顺带：拼接用 `result.replace(fullMatch, ...)`，O(块数 × 全文长度)。

## 决策

- 新建 `context/highlight-worker.ts`（纯 shiki `createHighlighter`，进 `{id, code, lang}` 出 `{id, html}`，语言懒加载常驻）与 `context/highlight-pool.ts`（2 worker 常驻、round-robin、单调用 10s 超时、连续 3 次失败熔断整池）。
- RedCode 主题从 marked.tsx 抽到 `context/shiki-theme.ts`，worker 与主线程兜底共用同一份——输出逐字节一致，markdown.tsx 的块缓存两边通用，颜色全是 CSS 变量所以不随主题切换失效。
- `highlightCodeBlocks` 改为：worker 池可用时逐块并发派发（`Promise.all`），单块失败只降级该块（主线程兜底 = 原实现）；拼接改按 `matchAll` 索引切片，消灭 O(n²) replace。
- 兜底链：无 `window`/`Worker`（bun test、SSR）→ 池构造失败 → 单调用超时/报错 → 连续失败熔断，全部落回主线程原路径。最坏退化等于改动前。

## 备选与否决理由

- **复用 `ui/pierre/worker.ts` 的 WorkerPoolManager**：否决——那是 diff/file 渲染专用协议（AST + renderer 实例 + file/diff 缓存），没有裸 `codeToHtml` 入口，硬蹭会把 diff 的缓存语义与实例生命周期拖进 markdown 路径。
- **接通 desktop 已有的 parse-markdown 主进程 IPC**（审计确认全仓 0 调用点）：否决——跨到主进程只是换个线程，序列化成本更高，且主进程那份是 marked（260802 已因 O(n²) 在渲染层淘汰），接通前还得先重写。
- **加大 markdown 块缓存（LRU 200）让高亮少跑**：否决——治标，首次渲染与缓存抖动（长会话滚动）仍卡主线程；那是另一条已知的独立问题。
- **流式期间也高亮**：否决——260811 已论证每 tick 全量 codeToHtml 不可接受，维持流式跳过、结束补全。

## 后果

代码块高亮不再占 UI 线程（首次出现某语言时 worker 内付一次懒加载）；输出 HTML 与改动前逐字节一致，缓存与样式零迁移。新增 2 个常驻 worker（与 pierre 的 2 个合计 4 个），各自按需懒加载 shiki 语言 chunk。已知代价：worker 内也各有一份 shiki 核心与已加载语言（内存换主线程）；跨进程序列化按块计，块本身 <10KB，量级可忽略。
