# 工具结果模型侧多模态 token 硬预算与可恢复 spill

日期：2026-09-23
状态：implemented
分区：feature

## 问题

模型可见内容必须有确定的硬上限。MCP 路径原有 5MiB base64 + 32 条限制，但插件和其他
工具生产者绕过了这层；同时 PDF 在 token 估算中计 0，公共结果边界此前没有字节或数量闸门。
图片则按视觉投影计价，单独通过文本预算并不代表字节开销有界。本仓已经两次栽在「写的时候
没人问上限」：`tool/read.ts` 的图片分支（库里最大单条 3.23MB）与 `summary.diffs`
（单行 32MB，占 message 表 79%）。

## 方案

- `session/image-tokens.ts` 新增 `TOOL_RESULT_TOKEN_BUDGET = 14_000` 与纯函数
  `fitToolResult()`：文本按 `Token.estimate`（chars/4）、图片按
  `imageRequestTokens(model)` + JSON 包壳（`ATTACHMENT_ENVELOPE_TOKENS = 32`）计价。
- `tool/truncate.ts` 新增 `result()`：同一预算的副作用版本，超预算部分 spill 到
  `TRUNCATION_DIR`（完整文本 + 被丢附件的 `tool_<id>_media/`）。
- 三个入口改调 `result()`：`tool/tool.ts` 的 `wrap()`、`tool/registry.ts` 的
  `fromPlugin()`、`session/tools.ts` 的 MCP 路径。
- `session/message-v2.ts` 的 `toUIMessages` 用同一个纯函数做兜底（不碰 fs），覆盖
  本次改动之前落库的结果，以及绕过 truncate 的写入方。
- `fitToolResult()` 对所有工具结果共享 5MiB 单附件 payload 上限与 32 条上限；
  `session/tools.ts` 复用相同常量，在构造巨大 data URL 之前先做 MCP 侧保护。
- 对 payload 字节数无法在本地确认的 scheme URL（如远程 HTTP 文件）采取 fail-closed，
  作为超限附件丢弃；不能用 URL 字符数冒充远程文件大小。

## 关键取舍

**预算取 14_000**：略高于既有纯文本上限（`MAX_BYTES = 50 KiB ≈ 12,800 token`）。

代价说清楚：纯文本结果的上限从 51,200 字节松到约 56,000 字符，也不再受 2000 行的
条数线约束。那两条旧线本质都是「模型可见大小」的代理，现在由 token 预算统一接管，
而它是硬线；换来的是「文本 + 附件」合成结果从**一条线都没有**变成 14,000 token
硬顶。不是零变化，是一次有意为之的松绑 + 收紧（松的是纯文本代理线，紧的是多模态）。

**非图片媒体（PDF）在 token 预算里仍计 0**：真实开销按页计、从字节推不出来。按
base64/4 计的话 5MiB 就是约 1.7M token，会把每一个合法 PDF 都判出局 —— 比这点不精确更糟。
现在所有生产工具结果共用 5MiB 单附件与 32 条硬限；无法测量 payload 大小的远程 URL
不发送。`estimateModelMessages` 仍按序列化长度计 PDF，那是压缩路径的保守上界，与这里
的预算口径不同。

**先截文本、后丢附件**：附件不可拆，文本可拆；`TEXT_FLOOR = 400` 保证附件再多也给文本
留预览，否则纯图结果会把正文挤成空串。

**notice 入账**：调用方追加的提示（「完整内容在 <路径>」）本身也进模型上下文，所以
`fitToolResult` 接受 `options.notice` 并显式从预算里扣掉，而不是猜一个固定预留值。
`truncate.result()` 因此走两遍：第一遍判 `truncated` → 写 spill → 用真实路径拼 notice
→ 第二遍带着 notice 重新 fit。

## fail-soft，不是 fail-open

deepseek-harness `ab102138c8` 的形状是：任何 spill/图片定价失败都 catch 后返回
`undefined`，调用方于是留下**未截断的原始结果** —— 预算整个作废。本仓的 `result()`
反过来：写盘失败仍返回**已截断的有界预览** + 一条「完整内容没能保存」的提示，绝不回退
成无界内容。

## 模型可见改动的四问

1. **模型看到什么变了**：PDF 等非图片附件不再能从插件或其他工具入口绕过硬线；单件超
   5MiB、超过 32 件或大小未知的远程文件会从本轮模型输入中移除。生产路径仍由
   `truncate.result()` 尽可能保存被移除内容并报告；历史回放兜底只能移除并附带预算提示。
   合法范围内的结果和既有文本预算行为不变。
2. **token 影响**：14,000 token 总预算不变。新增附件硬限是 5MiB 单件和最多 32 件；
   PDF 仍不按 base64/4 估 token。
3. **KV cache 影响**：只有结果包含超限/未知大小附件时，该 tool result 起的前缀会改变；
   其余结果不变。
4. **硬上限**：附件最多 32 件、每件最多 5MiB payload（乘积上限 160MiB）；结果另受
   14,000 token 预算约束。MCP 构造 data URL 前复用相同限制，远程 scheme 的未知 payload
   按超限处理。PDF token 价格为 0 是有意保留的近似，不再意味着附件没有硬界。

## `output()` 何去何从

三个生产入口都改调 `result()` 之后，`output()`（字节/行数线）在 src 里已无调用方，
仅测试还在覆盖它。本次不删：它是有测试的公共服务方法，删除属于独立重构。但它已经
不在生产路径上——后续要么删掉，要么把字节/行数线并回 `result()` 让它重新有调用方。

## 回链

- `packages/opencode/src/session/image-tokens.ts`（预算与 fit）
- `packages/opencode/src/tool/truncate.ts`（`result()` 与 spill）
- `packages/opencode/src/session/tools.ts`（复用附件硬限）
- 前序决策：`2026-08-17-tool-output-head-tail-truncation.md`（both/4:1 与「RedCode 的
  truncate 本身就是 DSH spill 的等价实现」）、`2026-08-28-route-priced-image-tokens.md`
