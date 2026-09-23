# 工具结果模型侧多模态 token 硬预算与可恢复 spill

日期：2026-09-23
状态：implemented
分区：feature

## 问题

模型可见内容必须有确定的硬上限。字节闸门已经有了两道：`tool/read.ts` 的附件上限、
`session/tools.ts` 的 5MB base64 + 32 条。但**字节不等于模型开销** —— 32 张各自合法
通过字节闸门的图，在模型侧是 32 × 视觉投影的账。字节线管的是内存，上下文此前一条线都
没有。本仓已经两次栽在「写的时候没人问上限」：`tool/read.ts` 的图片分支（库里最大单条
3.23MB）与 `summary.diffs`（单行 32MB，占 message 表 79%）。

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

## 关键取舍

**预算取 14_000**：高于既有纯文本上限（`MAX_BYTES = 50 KiB ≈ 12,800 token`），所以
纯文本工具结果的行为逐字节不变，这条线只对「文本 + 附件」的合成结果生效。

**非图片媒体（PDF）在预算里计 0**：它已经被字节线（5MB base64）与条数线（32）限住，
真实开销按页计、从字节推不出来。按 base64/4 计的话 5MB 就是约 1.7M token，会把每一个
合法 PDF 都判出局 —— 比这点不精确更糟。（`estimateModelMessages` 仍按序列化长度计
PDF，那是压缩路径的保守上界，与这里的预算口径不同。）

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

1. **模型看到什么变了**：工具结果从「字节截断」变成「字节 + token 双线」。纯文本结果
   逐字节不变；文本 + 图片合成结果可能多出 `[... N chars omitted, tool result over the
   model-visible token budget ...]` 标记与 spill 提示。
2. **token 影响**：纯文本路径 0 变化（14,000 > 12,800）。多模态路径上限从「无」变成
   14,000 token。
3. **KV cache 影响**：工具结果内容变化 → 从该 tool result 起的前缀作废；纯文本不变。
4. **硬上限**：`TOOL_RESULT_TOKEN_BUDGET` 是常量，不随配置变化（配置只管字节/行数的
   `tool_output`）。单项 14,000 token，超过 1K 在此点名：它刻意高于文本线，使纯文本
   路径零变化。

## 回链

- `packages/opencode/src/session/image-tokens.ts`（预算与 fit）
- `packages/opencode/src/tool/truncate.ts`（`result()` 与 spill）
- 前序决策：`2026-08-17-tool-output-head-tail-truncation.md`（both/4:1 与「RedCode 的
  truncate 本身就是 DSH spill 的等价实现」）、`2026-08-28-route-priced-image-tokens.md`
