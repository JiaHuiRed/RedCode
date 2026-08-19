# TUI 侧边栏上下文窗口：口径修复 + 显式标注

状态:implemented

## 问题

哥哥的原话：「现在只有总 tokens 显示，搞得我以前一直以为这个是上下文窗口，还以为怎么动不动就超过几倍十几倍了」。

查下来一半是**读法**问题、一半是**真 bug**。

**读法**：侧边栏其实早就有上下文占比，就是第一行 `185,925 tokens · 19%`。哥哥看成上下文窗口的是紧挨着的第二行 `Total 15,416,562 tokens`——那是会话累计消耗，本来就该无限涨。两行都没标签，头顶又只有一个 `Context` 标题，读者会把整块糊成一件事。

**真 bug**：那个 19% 的分子拿错了。

```ts
const tokens = last.tokens.total ?? (input + output + reasoning + cache.read + cache.write)
percent = modelInfo?.limit.context ? Math.round((tokens / modelInfo.limit.context) * 100) : null
```

`tokens.total` 在 `processor.ts` 里是**跨 step 累加**的（`total: (prevTokens.total ?? 0) + (usage.tokens.total ?? 0)`）。那是 260706 特意改的，为了让 cost 与缓存命中率对得上账，对这两个用途完全正确；但一次 assistant 消息含几次工具往返就累加几次请求的 total，拿它当上下文，长工具链下会显示成真实值的十几倍。

代码里留着这件事被看见过的痕迹：

```ts
if (p > 200) return `${p}% ⚠`   // percentLabel
```

有人见过它飙到 200% 以上，加了个 ⚠ 糊过去，没动口径。

这与 `a94ea6ad`（260818，压缩分割线「42137k → 42374k 越压越多」）是**同一个口径坑的两处**——那次修了 compaction 侧改用 `estimate(filterCompacted 可见消息)`，侧边栏这处漏了。

## 决策

**在 `getUsage` 里把已经算好的数带出来，而不是让消费端事后拼。**

`session.ts` 的 `getUsage` 早就有 `const contextTokens = inputTokens`（峰谷/分档计价在用），它就是「本次请求提示词总量」= 这一刻的上下文大小。把它放进返回的 `tokens.context`，一路透到 assistant 消息。

**为什么不让侧边栏把 `input + cache.read + cache.write` 加回来**：`cache.read` 存的是**未经上限钳制**的原始值（DeepSeek 会报 `cached_tokens > prompt_tokens`，KV 缓存聚合口径 vs 单次请求），而 `input` 是扣掉**钳制后**的值算出来的。两者不同源，加回来在缓存超报时会超过真实提示词量。单测里专门钉了这条。

**`context` 覆盖而非累加**，与紧挨着的 `total` 形成对照——这是本次的核心，注释写在赋值处。

**schema 用可选字段**：message 行是 JSON blob 存的（`session.sql.ts` 的 `data: text({ mode: "json" })`），加可选字段不用迁移，历史消息照常解码。历史消息没有这个字段时侧边栏整块不显示，等本会话下一轮请求写入——比拿个已知错的数糊上去诚实。

**显示**：`Context window` 标题 + `186k / 1M · 19%` + 24 格进度条（绿 <60%、黄 60–85%、红 ≥85%），与下面的 `Session total` 用空行隔开。侧边栏宽 42 列，所以数字走紧凑记法。

## 顺带暴露的两件存量问题

1. **生成产物落后于源 schema**。重跑 `packages/sdk/js/script/build.ts` 后，除了本次的 `context`，还一并补上了 `timeout_ms` / `fallback_model`（`eeb93c5f` 子代理超时兑底）、`subagent_depth`（上游采摘）——这些改了 schema 但没重跑生成。
2. **`provider.ts` 一处类型错被这份落后掩盖着**。`reasoningOptions` 的 schema 是 `Schema.MutableJson`（外部 models.dev 数据，刻意不收紧），生成链把它压成 `unknown`；插件 `models()` 的返回值走生成类型，spread 进来赋不回内部的 `MutableJson`。生成产物一更新就红。值本身是 JSON 过来的，就地窄回去，注释标明这不是本次引入的。

`packages/sdk/openapi.json` 仍是旧的——它由 `script/generate.ts` 生成，而那个脚本 `.cwd("packages/redcode")` 指向一个**不存在的目录**（包名是 `packages/opencode`），等于这条生成路径已经死了，文件一直靠手改维护。留到下一条 commit 单独处理，不跟功能混。

## 备选与否决理由

- **侧边栏自己按可见消息估算上下文**：否决——TUI 侧拿不到 `filterCompacted` 后的可见消息，也不该在渲染路径上跑估算；服务端本来就有准确值。
- **复用 `StepFinishPart` 的逐 step tokens**：否决——那是 part，DCP 的 prune 会删 part，靠它取值不稳；消息级字段更结实。
- **给历史消息回填 `context`**：否决——原始 per-step 数据没留，回填只能靠猜。
- **一步做成完整分解面板**（Messages / System tools / MCP tools / Skills / Free space）：哥哥拍板暂缓，先把「数字是错的」这个真 bug 解决掉。分解需要动 SDK schema 分桶 + 侧边栏折叠交互，单独排。

## 后果

- 测试：`compaction.test.ts` 的 `SessionNs.getUsage` 块新增 3 例（context = 提示词全量不含输出 / 含缓存读写时仍为全量 / **DeepSeek 缓存超报时三字段相加虚高而 context 不受影响**——这条就是「不能让消费端加回来」的理由）；新建 `test/cli/cmd/tui/sidebar-context.test.ts` 4 例（紧凑记法量级切换、进度条两段恒等宽、越界百分比钳制不画穿、颜色两个门槛）。
- 全量：compaction 64 + sidebar 4 + negative-tokens + prompt-usage + message-v2 共 124 例全绿，`tsc --noEmit` 干净。
- `test/provider/transform.test.ts` 有 1 例既有失败（`replaces lone surrogates in model-visible text`），在 HEAD 上同样红，与本次无关。
