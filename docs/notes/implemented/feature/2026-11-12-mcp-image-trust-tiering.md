# MCP 工具结果的图片信任分级

状态:implemented

## 问题

RedCode 的工具结果预算已经很完整：`session/image-tokens.ts` 的
`TOOL_RESULT_TOKEN_BUDGET = 14_000`、`MAX_ATTACHMENT_BASE64_BYTES = 5 MiB`、
`MAX_ATTACHMENTS = 32`，`tool/truncate.ts` 的 `result()` 会把超预算的文本与附件 spill 到
磁盘（`tool_<id>_media/`），`tool/read.ts` 的图片分支有 32 MB 磁盘上限，`session/tools.ts`
还有 5 MB base64 + 32 条的前置闸门。**字节与 token 两层都已有上限。**

缺口在信任边界：`session/processor.ts` 的 tool-result 分支对**所有** `image/*` 附件跑
`image.normalize`（解码、缩放、可能重新编码），注释明确「覆盖 read / webfetch / MCP /
plugin / task 全部产图来源」。其中 MCP 与 plugin 是外部输入，第三方 payload 的解码会
把解码器暴露成通用攻击面（CPU 放大、解析器漏洞），而 RedCode 此前没有来源区分。

对照 ZCode（`E:\AI\ZCode\docs\mcp-tool-output-budget.md`）：普通第三方 MCP 图片
**不执行 CPU 密集型压缩**，超过 200 KiB 直接进 artifact 策略；只有可信宿主工具
（`node_repl/js`）才允许 `ImageProcessorPort` 压缩后继续 inline，并复验 base64 字节数。

## 决策

- `MessageV2.FilePart` 新增可选 `metadata`（`Schema.Record(Schema.String, Schema.Any)`），
  随消息 part 持久化，`toModelMessages` 不读取，因此不影响模型输入与固定前缀。
- `session/tools.ts` 的 MCP 工具循环（`image` 与 `resource.blob`）以及
  `read_mcp_resource` 的 `formatMcpResourceContent` 构造附件时写
  `metadata: { trust: "untrusted" }`；`tool/registry.ts` 的 `fromPlugin` 对插件附件做同样
  标记。
- `session/processor.ts` 新增 `shouldNormalizeToolImage()`：`image/*` 且
  `metadata.trust !== "untrusted"` 才跑 `image.normalize`；untrusted 附件直接透传，仍由
  `truncate.result` / `ImageTokens.fitToolResult` 执行字节与 token 预算，超预算走既有
  spill（`writeMedia`）。
- 默认值：没有 metadata 的附件视为可信（内置工具不额外标记）。外部入口只有 MCP 与
  plugin 两处，集中标记，不依赖工具名前缀启发式。

不改 `fitToolResult` 的预算常量，不改 spill 格式，不改 provider 请求结构。

## 备选与否决理由

- **全都不 normalize**：否决——内置 read/截图依赖缩放到 ≤2000px 才能稳定进入模型预算。
- **全都 normalize（原状）**：否决——把第三方 MCP payload 的解码风险留在主进程。
- **按 mime 白名单**：否决——mime 由外部声明，不可信；信任边界必须来自调用来源。
- **按工具名前缀（如 `mcp__`）判断**：否决——MCP 与 plugin 的注册名不统一，启发式不能
  作为安全边界。

## 后果

- 第三方 MCP/plugin 图片不再被自动缩放；超预算时落盘，模型只看到路径。MCP 提供方需要
  自己控制输出尺寸。这是有意的行为变化。
- 忘记标记的外部来源会回到 trusted。新增外部工具入口（新的 MCP 桥、新的插件工具出口）
  时必须显式写 `trust: "untrusted"`。
- `FilePart` 进 OpenAPI：已重新生成 SDK 与 `packages/sdk/openapi.json`，
  `check:openapi-drift` 一致（784,495 字符）。
- 与 `image-tokens.ts` 的既有注释（260928 Red「shared fitter 也管 plugin 与 replay 路径」）
  一致：预算仍在共同出口执行，只有解码这一步按来源分级。

## 实现记录（2026-11-12）

- 代码：`message-v2.ts`（`FilePart.metadata`）、`session/tools.ts`（MCP 附件标记）、
  `tool/registry.ts`（plugin 附件标记）、`session/processor.ts`
  （`shouldNormalizeToolImage` + tool-result 分支）。
- 测试：`test/session/tool-image-trust.test.ts`（3 条纯函数用例）、
  `test/session/mcp-resource-tools.test.ts`（blob 附件断言 metadata）。
- 验证：两个测试文件 11 pass / 0 fail；`test/plugin/trigger.test.ts` 与
  `loader-shared.test.ts` 33 pass；`bun run typecheck` exit 0；
  `bun run test:smoke` exit 0；OpenAPI drift 一致。
- 来源：ZCode v3.15.1 吸收调研（2026-11-12）。
