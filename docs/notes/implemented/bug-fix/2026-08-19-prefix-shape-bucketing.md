# PrefixShape 全局单槽 → 按 sessionID|modelKey 分桶（同形状漏网的第三次）

状态:implemented

## 问题

`session/prefix-shape.ts` 的诊断状态是**全局单槽**：

```ts
const pfx = ((globalThis as any).__rc_prefix_shape ??= {
  shape: undefined as { sessionID: string; shape: PrefixShape } | undefined,
})
const prev = pfx.shape?.sessionID === sessionID ? pfx.shape.shape : undefined
pfx.shape = { sessionID, shape }
```

两个毛病，跟 `5670d86`（260819）在**前缀探针**那边刚修掉的是同一对：

1. **不带 modelKey → 误报**。system 提示词本来就按模型分发（`system.ts` 是 15 分支的 BEAST / CODEX / GEMINI / ANTHROPIC / DEEPSEEK / QWEN / GLM… 路由，`_caches.system` 也按 modelKey 分桶），同会话切模型 `systemHash` 必变 → 每次切模型报一次假的「prefix cache changed: system」。
2. **单槽被并发会话/子代理互顶 → 漏报**。子代理跑的是独立 sessionID、走同一套 runLoop，主会话与子代理交替 `diagnose` 时 `prev` 恒取不到（sessionID 对不上）→ 真断裂不报。漏报比误报难发现得多。

`5670d86` 修探针时给 key 补了 modelKey，但没看兄弟函数——**「修一个、漏一个同形状的」在这个仓里已经是第三次**（前两次见 `project-freeze-bug-family` 的支线 A）。

## 决策

`Map<string, PrefixShape>`，key = `${sessionID}|${modelKey}`，与 `_caches.system` / 探针的分桶键同粒度。`diagnose` 的签名加一个必填 `modelKey`——故意做成必填而非可选：可选参数会让将来新增的调用点默默退回单桶行为，必填则由 typecheck 逼着每个调用点表态（本次就是靠它把 9 处用例调用一次揪全的）。

顺带接上回收。纯诊断状态，每条只有两个短 hash + 两个数，回收代价为零，接上只为不再无界。

## 顺带：回收逻辑第三次出现，抽成共用件

同一段「TTL 为主 + 数量为辅 + 当前 key 永不自我回收」的惰性清扫，`1fdf29c` 时在 `prompt-caches` 和 `file/time` 各写了一遍，这次是第三处。抽到 `util/session-evictor.ts`：

```ts
sessionEvictor({ ttlMs, max, drop, seen? })  // → { touch, forget, size, clear }
```

`seen` 可外部注入，是给 `prompt-caches` 那种要跟缓存本体放同一个 globalThis 槽的场景用的——分开放会让「模块被实例化多次」时各实例按各自的视图回收共享数据。阈值（1 小时 / 32 会话）也收在这个模块里，理由写在那里：回收活跃会话要付一次全额前缀重建，所以上限取得宽松。

## 后果

- 测试：`prefix-shape.test.ts` 原 5 例全部补上 modelKey 参数，新增 2 例回归——「同会话切模型不误报 system 变化」（含切回来要跟自己上一轮比）与「并发会话/子代理交替诊断时互不顶掉」（parent 真变了要报、child 没变不能被带着报）。加 `reset()` 测试钩子 + `beforeEach` 隔离，12 例全绿。
- **两条新用例没有拿旧实现跑对照**：签名从 3 参变 4 参、且新增了 `reset` 导出，旧实现下用例文件根本加载不了。它们挂在旧实现上是从代码推的——单槽下同会话切模型 `prev` 取得到但 hash 必不同（误报），并发会话 `prev` 恒取不到（漏报）。
- `prompt-caches` / `file-time` 改用共用件，行为不变，原有 8 例回收用例全绿。
