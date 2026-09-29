# Timeline 行高缓存表收编为唯一所有者

状态:implemented

## 问题

外部审计（`docs/notes/proposed/architecture/2026-09-24-incremental-audit.md`）在 GUI 会话
时间线上记录了两条缓存缺陷，都属于「同一职责分散在多个写入点」：

- **§3.5 跨会话别名**：`writeTimelineCache` 有三处调用（`:739`/`:749`/`:758`），都能拿组件级
  `let virtualizer` 配另一条时间线的 session key。切会话 A→B 时无论 `createEffect` 与 keyed
  `Show` 谁先销毁，必然出现「新 key + 旧 handle」或「旧 key + 新 handle」的配对写入，
  `timelineCache` 里某会话的条目于是指向另一个会话正在写的 cache 对象。`cacheReusable` 只比
  row key 前缀，比对必然通过 —— 切回会话时把别人的实测尺寸当自己的用，行高错位，且 `itemSize`
  因 cache 非空而丢掉 60px 兜底。
- **§3.7 resize 只删不写**：读路径 `readTimelineCache` 在 `createMemo` 体内 `delete`（副作用），
  而缓存有效域含 viewport 宽度、回写 effect 只依赖 `[sessionKey, timelineRowKeys]`。resize 后
  条目被删而没有人再写，下一次行插入又走 60px 兜底 → 整列塌缩重测，「闪一下」原样存活。

## 决策

- 行高缓存表收进 `message-timeline.data.ts` 的 `TimelineCache.CacheTable`（纯模块、可单测），
  成为唯一所有者：`read` 纯净化（不可复用只返回 undefined，不淘汰），淘汰只能走显式
  `invalidate`，`write` 带宽度守卫。
- handle 与 session 的唯一配对点是 `Virtualizer` 自己的 `ref`：挂载时记录
  `mounted = { session, keys, handle }`，销毁时只写这个实例自己的 session。刷新 effect 只写
  「当前挂载实例自己的 session」，会话已切走时直接返回。组件级那五个 `let`
  （`virtualizer`/`cacheSessionKey`/`cacheRowKeys`/`virtualizerSessionKey`/`virtualizerRowKeys`）
  全部删除，其余引用点改走 `mounted?.handle`。
- `listWidth` 进入回写 effect 依赖；宽度刚变时 `write` 返回 false（handle 里还是旧宽度的实测值，
  直接写会被 `cacheReusable` 接受然后用错误 offset 算可视区间），此时先 `invalidate` 再于 rAF
  里等 virtua 重测落地后补写。

## 备选与否决理由

- **照搬 ZCode 的「按 row key 逐条存行高」**：否决 —— virtua 的 `CacheSnapshot` 是不透明品牌类型
  （`[cacheSymbol]: never`，官方文档明说不许修改），快照只能整份复用，无法按行粒度注入或读取。
  行粒度只能等 virtua 开放 cache 结构后再做。
- **在 `readTimelineCache` 里保留 delete**：否决 —— memo 体内的副作用会让「同帧再算即 undefined」，
  正是 §3.7 的触发形态；淘汰改由 write 路径的 LRU 与显式 invalidate 承担。
- **宽度变化后立即写回**：否决 —— virtua 尚未重测，存进去的是旧宽度的实测值。

## 后果

- 切会话不再可能把 A 的实测尺寸配到 B 的条目上；缓存写回只剩一条路径（实例自己的 ref）。
- resize 后先淘汰、重测落地再写，下一次行插入不再必然塌缩到 60px。
- `CacheTable` 为泛型实现，不依赖 virtua 类型，可在单测里用字符串当快照。
- 新增 7 条 `CacheTable` 用例（纯读、宽度守卫、invalidate 后重写、会话互不串台、LRU 淘汰）。

## 回链

- `packages/app/src/pages/session/message-timeline.data.ts`（`TimelineCache.CacheTable`）
- `packages/app/src/pages/session/message-timeline.tsx`（`mounted` 配对、回写 effect、ref）
- `packages/app/src/pages/session/message-timeline.data.test.ts`
