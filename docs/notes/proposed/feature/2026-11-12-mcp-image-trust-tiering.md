# MCP 工具结果的图片信任分级

状态:proposed

## 问题

RedCode 的工具结果预算已经很完整：`session/image-tokens.ts` 的
`TOOL_RESULT_TOKEN_BUDGET = 14_000`、`MAX_ATTACHMENT_BASE64_BYTES = 5 MiB`、
`MAX_ATTACHMENTS = 32`，`tool/truncate.ts` 的 `result()` 会把超预算的文本与附件 spill 到
磁盘（`tool_<id>_media/`），`tool/read.ts` 的图片分支有 32 MB 磁盘上限，`session/tools.ts`
还有 5 MB base64 + 32 条的前置闸门。**字节与 token 两层都已有上限。**

缺口在信任边界：`session/processor.ts:872-891` 对**所有** `image/*` 附件跑
`image.normalize`（解码、缩放、可能重新编码），注释明确「覆盖 read / webfetch / MCP /
plugin / task 全部产图来源」。其中 MCP 与 plugin 是外部输入，第三方 payload 的解码会
把解码器暴露成通用攻击面（CPU 放大、解析器漏洞），而 RedCode 目前没有来源区分。

对照 ZCode（`E:\AI\ZCode\docs\mcp-tool-output-budget.md`）：普通第三方 MCP 图片
**不执行 CPU 密集型压缩**，超过 200 KiB 直接进 artifact 策略；只有可信宿主工具
（`node_repl/js`）才允许 `ImageProcessorPort` 压缩后继续 inline，并复验 base64 字节数。
它的取舍是「宁可让第三方大图落盘、模型只拿路径，也不把不可信 payload 变成通用图像解码
攻击面」。

## 决策

在工具结果进入 processor 之前带上来来源信任标记：

- 内置工具（read / webfetch / task / 内置截图）→ `trusted`
- MCP、plugin、外部扩展 → `untrusted`
- `processor.ts` 的 tool-result 分支只对 `trusted` 附件跑 `image.normalize`；
  `untrusted` 附件跳过解码，直接交给 `ImageTokens.fitToolResult` 做字节/token 闸门，
  超预算走既有 spill 路径（`truncate.result` 的 `writeMedia`）。
- 日志与 metadata 记录 `normalizeSkipped: "untrusted-source"`，便于排查「图没被缩放」。

不改 `fitToolResult` 的预算常量，不改 spill 格式，不改 provider 请求结构。

## 备选与否决理由

- **全都不 normalize**：否决——内置 read/截图依赖缩放到 ≤2000px 才能稳定进入模型预算。
- **全都 normalize（现状）**：否决——把第三方 MCP payload 的解码风险留在主进程。
- **按 mime 白名单**：否决——mime 由外部声明，不可信；信任边界必须来自调用来源。

## 后果

- 第三方 MCP 大图不再被自动缩放，可能直接落盘，模型只看到路径；MCP 提供方需要自己
  控制输出尺寸。这是有意的行为变化。
- 需要给 `Tool.Context` 或 tool result 增加来源字段，并确保所有工具出口都显式赋值
  （默认 `untrusted`，内置工具显式 `trusted`），避免「忘记标记 = 静默放开」。
- 与 `image-tokens.ts` 的既有注释（260928 Red「shared fitter 也管 plugin 与 replay 路径」）
  保持一致：预算仍在共同出口执行，只是解码这一步按来源分级。
- 决策记录回链：立项来自 ZCode v3.15.1 吸收调研（2026-11-12）；实现后移入
  `implemented/feature/`。

## 实施面侦察（2026-11-12，未动工）

信任来源目前没有可用的传播通道，两个候选路径都需要跨模块改动：

- **路径 A：扩展 `MessageV2.FilePart`**（`message-v2.ts:198-206`）加 `trust` 或 `metadata`
  字段，由 `Tool.execute` 出口（`tool/tool.ts:168` 的 `truncate.result` 调用点）按工具
  来源赋值，`processor.ts:872-891` 读取。成本：FilePart 进 OpenAPI，需要跑
  `check:openapi-drift` 与两条 SDK 生成命令；所有 `attachments` 出口都要显式赋值，否则
  默认值决定行为。
- **路径 B：registry 暴露外部工具集合**，processor 在 tool-result 分支按 tool 名查询；
  `processor.ts` 当前没有 import `tool/registry`，需要先确认依赖方向不成环（registry 被
  `session/tools.ts` 使用，processor 与 tools 的关系要查清）。
- 现状可用的启发式（按 `mcp__` 前缀判断）不可靠：MCP 与 plugin 的注册名不统一，不能作为
  trust 边界。
- 结论：这一条需要单独一个批次，先定传播路径再改代码；本次只完成立项，不改实现。
