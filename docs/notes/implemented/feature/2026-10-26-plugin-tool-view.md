# 插件工具结果的展示协议

状态：implemented

## 问题

插件与自定义工具没有专用 renderer，`GenericTool` 此前只渲染「called `<tool>`」和入参摘要，**正文完全不可见**。插件作者把结果放在 `output` 里，用户在 GUI 里看不到，只能去别处找。

同时缺少一个可声明的展示层：插件知道自己的结果该怎么呈现（几个文件、哪些字段、哪段摘要），但只能塞进纯文本。

## 决策

### 1. 通用工具先显示正文

`packages/ui/src/components/basic-tool.tsx` 的 `GenericTool` 把 `output` 渲染进折叠区，复用既有 `data-component="tool-output"` 容器与 `Markdown`，与内置工具一致。默认仍收起，首屏观感不变；超过 20000 字符截断并标出剩余量，避免一次挂载整段大输出。

时间线签名（`message-timeline.tsx` 的 `activeAssistantContentVersion`）本来就看 `output.length`，流式追加会自动触发重渲染，不需要额外改动。

### 2. `ToolResult.view`：纯数据展示协议

`packages/plugin/src/tool.ts` 新增可选字段：

```ts
type ToolViewSection =
  | { type: "text"; title?: string; text: string }
  | { type: "items"; title?: string; items: Array<{ label: string; value: string }> }

type ToolView = { summary?: string; sections?: ToolViewSection[] }
```

- `summary` 放在工具行副标题位置（替代入参摘要），一眼可见。
- `sections` 进折叠区；只认 `text` 与 `items` 两种，未知类型跳过。
- 没有 `view`、或 section 全不认识时，退回原始 `output` 文本。

### 3. 宿主侧映射与硬上限

`packages/opencode/src/tool/registry.ts` 的 `fromPlugin()` 把 `view` 合并进 `metadata`（`metadata.view`），**不新增 schema、不动 OpenAPI、不加 migration**。

`view` 是插件自定义 JSON，必须有界：序列化超过 8KB 整块丢弃并 `log.warn`，客户端退回 `output`。这条按仓库「注入项必须有硬上限」的红线执行。

时间线签名补一项 `metadata.view` 的序列化长度。`view` 只在工具结束时写入一次、不随流式变化，用长度足够触发首次渲染，不必每帧 stringify。

## 备选与否决理由

- **新增一等 schema 字段（core/session-message.ts）**：否决——要走 SDK 与 OpenAPI 重新生成，收益与成本不成比例；`metadata` 已是插件进入前端的既有通道。
- **服务端 renderer 函数 / 任意 HTML**：否决——函数过不了 SDK 边界，HTML 需要额外净化，且违反「不加载任意前端脚本」的约束。
- **`metadata` 直接塞展示结构、不定义类型**：否决——插件作者需要可发现的契约，类型本身是文档。

## 后果

- **模型可见面零变化**：`view` 只落在 tool part 的 `state.metadata`，不进模型上下文。工具 `output` 与该批之前完全一致。
- 单条 view 上限 8KB，写入 part 表；超限记录一条 warn，不阻塞工具结果。
- 旧插件不受影响：没有 `view` 就走原始 `output` 渲染。
- GUI 与 TUI 各自消费：GUI 已接 `GenericTool`；TUI 侧本轮未改，`view` 在那里不显示，退回 `output`。

## 验证

- `packages/opencode`：`registry.test.ts` 41 pass / 0 fail，含「view 透传到 metadata」「超限 view 被丢弃」两条新用例。
- 类型检查：`plugin` / `ui` / `app` / `opencode` 四个包 `exit=0`（opencode 走 tsgo 崩溃后的 TS5 回退，90s）。
- **GUI 实测（dev 栈 4097 + 5173）**：打开本会话时间线，MCP 工具走的就是 `GenericTool`（标题形如「调用了 `webqa_webqa_interact`」）。点击已完成工具的折叠触发器后出现 `[data-component="tool-output"]`，`innerText` 长度 400 字符——改动前这里为空。运行中的工具仍不可展开，沿用 `BasicTool` 的既有 `pending()` 约束。
