# 图片不再按 base64 长度计价：保留预算与用量面板

日期：2026-08-28 · 状态：implemented · 来源：deepseek-harness `.agents/notes/implemented/feature/2026-08-24-route-priced-image-request-pressure.md`（形态借用，数值与实现是自家的）

## 问题

`SessionCompaction.estimate` 是：

```ts
const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
return Token.estimate(JSON.stringify(msgs))
```

而 `Token.estimate` 就是 **chars ÷ 4**（`util/token.ts`），`toModelMessages` 把图片拼成**内联 data URL**（`message-v2.ts` 的 file part）。于是一张 400KB 的 JPEG 在这里被算成约 **13 万 token** —— 它在 DeepSeek 上实际最多 384。

**触发线没被带偏**：`level()` 取 `Assistant["tokens"]`，锚在 provider usage 上，这一点是对的，本次不动。被带偏的是两处下游：

1. **保留范围**（`select()`）：倒着累加各轮 `size` 直到超 `preserveRecentBudget`。一张图必然让它所在那轮超预算，`splitTurn` 再往前切也切不出装得下的片，于是 **图片所在轮及更早的全部被判出局**——即使那些内容加起来只有几千 token。
2. **用量面板的上下文构成**（`context-snapshot.ts` 的 `messageTokens`）：同样 `Token.estimate(JSON.stringify(content))`，"messages 占多少"被一张截图完全带偏。这个文件头写着"在真正发出去的那一刻记账"，本意就是要准。

## 决策

新增 `session/image-tokens.ts`，把**事实**与**定价**分开：

- `countModelMessageContent(value)` 返回**路由无关**的事实 `{ text, images }`。内联载荷在计长度前换成短占位串；远程图片 URL 原样保留（它本来就只占自己那点长度），但**同样计入一张图**——不然就成了反方向的失真，上游正是因为把图按结构 JSON 算成约 40 token 而让压缩迟到溢出。
- `imageRequestTokens(model)` 按 `providerID` 给一张图的价。
- `estimateModelMessages(messages, model)` = 事实 + 定价。

**取 384（DeepSeek 官方 v4 视觉计算器的封顶：14px patch、3:1 下采样、384 上限），不按尺寸精算。** `FilePart` 不带宽高，要拿到得解码；而 `image.ts` 已经把图归一化到 ≤2000×2000，那个尺寸下投影本来就顶到封顶附近。方向保守——只会高估不会低估，最大误差 384，对照现状的约 13 万。

按供应商的表当前只有 `deepseek` 一条，**默认值刻意等于它**：这样即使 `providerID` 的键写错也不会静默改变行为（对症 memory 里 DCP 触发线键写错静默回落那次）。等真要分档时，新增的键必须先对着实际 provider 列表验过。

`context-snapshot.ts` 的 `WeakMap` 缓存从"存 token 数"改成"存路由无关事实"，价钱在读的时候按当前 `providerID` 现算 —— 存价钱的话换模型之后留下的是上一条路由的价。这一条是照搬 DSH 的 route-priced surface 形态（节点存事实，`measure()` 时定价）。

## 备选与否决理由

- **逐字移植 DeepSeek v4 视觉计算器**（DSH 在 `llm-deepseek/request-pricing.ts` 里做了，还有 pinned 向量）：本轮否决。它要图片宽高，本仓的 `FilePart` 不带；为了估算而解码每张图，成本远大于把 13 万修成 384 这一步的收益。真要精算时这是明确的下一步，公式来源已记在这里。
- **顺手把触发线也改成路由计价**：否决。`level()` 锚在 provider usage 上，那是完成请求的权威事实，改它是退步。DSH 的 note 也明说 usage 仍是锚、路由投影只给增量定价。
- **把图片从估算里整个剔除（计 0）**：否决。那是上游踩过的坑的另一面 —— 图密集的会话会因为压力被低估而压缩迟到、直接溢出。

## 验证

`test/session/image-tokens.test.ts`（10 例）：无图时与朴素估算逐位相等；200KB 内联图从 >40,000 降到 <500 且 ≥384；**估算不再随载荷大小变化**（10KB 与 256KB 同值）；三张图比一张图恰好多约 3×384；远程 URL 也计价（防反方向失真）；非图片附件（PDF）仍按序列化长度计；`{ mediaType, data }` 裸 base64 形态同样识别；空/undefined 输入不炸。

`test/session/context-snapshot.test.ts` 新增 3 例：一张图不再按 base64 长度计入 messages、载荷变大不改变记账、纯文本记账不受影响。

`bun run typecheck` exit 0。`bun test test/session/`：**基线 522 pass / 0 fail，带本次改动 535 pass / 0 fail**（差值 13 即新增用例数），用备份 + `git checkout` 做过两轮对照。

**过程中的一个教训值得留**：用例最初用 `"A".repeat(4 * 1024 * 1024)` 造 4MB 载荷，整目录跑时会让隔壁 `session.compaction.process > stops quickly when aborted during retry backoff`（一条 1 秒窗口的时序断言）失败，单跑该文件却是绿的。分离验证：**只有源码改动、不加新测试文件时是 522/0 干净**，所以病灶在测试自己的分配压力而不是被测代码。把载荷缩到 256KB 后整目录 535/0。造大对象证明"估算不随载荷增长"是没必要的——256KB 与 10KB 已经足够说明问题。

## 记账

- **精算未做**：见上，需要图片宽高。做的话落点是 `image-tokens.ts` 一个文件，`imageRequestTokens` 换成带尺寸的签名。
- **其余 `Token.estimate(JSON.stringify(...))` 调用点已核查**：`compaction.ts:403`（工具输出文本，不含图）、`context-snapshot.ts` 的 system/tools 段与 `prefix-shape.ts`（都是 system prompt 与工具 schema，不含图）。只有本次改的两处会遇到图片。
- `compaction.ts:442` 那条 260818 的注释（"显示 Compaction 42137k → 42374k 越压越多"）与本条同源——`tokensBefore`/`tokensAfter` 走的也是这个 `estimate`，本次一并变准了。
