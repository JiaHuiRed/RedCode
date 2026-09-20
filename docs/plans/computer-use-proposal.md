# RedCode Computer Use 方案

状态：审计后提案，未开始实现。

外部审计意见已合并：`E:\dwonload\RedCode_Computer_Use_Proposal_Review.md`。

本文用于审计 RedCode 是否适合接入 computer use，以及确定最小、可回放、可撤销边界清晰的实现路径。目标不是把鼠标点击能力直接塞进 agent loop，而是复用现有工具、权限、会话和附件链路。

## 结论

采用 **MCP-first、后端持有、UI 薄接入**：

1. 第一阶段先通过现有 MCP 链路接入外部 Cua Driver，只做 observe-only，验证截图、附件、回放和隐私负载。
2. 在任何输入动作前，先完成 `Observation`、`ActionOutcome`、`ObservationBarrier`、freshness/focus check、输入控制 lease 和重试语义。
3. 随后只增加高层 `click`，再根据真实结果增加 `type`、`key`、`scroll`；不首发 drag 或低级鼠标/键盘原语。
4. 暂不修改 agent loop，不在 Electron renderer 中执行桌面动作，不把 browser use 和 computer use 合并成一套低级 API。
5. `ComputerUse.Service`、provider registry、跨进程 lease、file-backed attachment 和 native driver 都后置到真实 PoC 数据之后。

## 当前可复用基础

### 工具执行

- `packages/opencode/src/tool/tool.ts`
  - `Tool.Context` 已有 `AbortSignal`、权限询问、session/message/call 标识。
  - `ExecuteResult` 已支持文本、metadata 和 `FilePart` 附件。
  - 工具级超时已由 `timeoutMs` 统一处理。
- `packages/opencode/src/tool/registry.ts`
  - 内建工具、插件工具和动态工具统一进入 `ToolRegistry`。
- `packages/opencode/src/session/tools.ts`
  - MCP 和内建工具都经过 `tool.use.pre`、`tool.execute.before/after`、Permission 和统一执行器。
  - MCP 图片/资源附件已有单条 5 MB、单次 32 条的上限。

### 会话、图片和 UI

- `packages/opencode/src/session/processor.ts`
  - 工具调用状态、完成结果、错误和取消都会写入 Session Part。
  - 图片结果统一经过 `Image.normalize`。
- `packages/opencode/src/session/message-v2.ts`
  - `ToolStateCompleted` 已能保存工具附件。
- `packages/opencode/src/image/image.ts`
  - 已有 base64、像素、尺寸和自动缩放预算。
- GUI/TUI 已能渲染工具结果和图片附件，因此第一版不需要新建 computer-use 专属 UI。

### MCP 和 Electron

- `packages/opencode/src/mcp/index.ts`
  - 已支持本地/远程 MCP、工具发现、工具白名单、超时、重连和结果转换。
- `packages/desktop/src/main/ipc.ts`
  - 已有可信 renderer IPC 校验，但它是 Electron 外壳能力，不是通用桌面驱动层。
  - Computer use 应放在 opencode 后端或独立 driver 进程，这样 TUI、GUI、headless 才能共用。

## 目标数据流

```text
模型
  ↓
SessionTools
  ↓
Permission + tool hooks
  ↓
Computer-use provider
  ↓
Cua Driver / MCP / native driver
  ↓
桌面截图与输入动作
  ↓
Image.normalize → FilePart → Session Part → GUI/TUI
```

Provider 提供具体工具 schema、动作和结果。RedCode 的共享层只负责执行管线、权限、日志、附件和必要的输入一致性状态。

第一版不预设 provider framework。只有出现第二个真实 provider 或重复的生命周期/lease/结果逻辑后，才抽取共同服务；共同服务也不定义 provider 的低级 click/type/screenshot API。

## 分阶段实施

### Phase 0：安全契约和负载验证

先不写代码，确定：

- 默认关闭，必须显式配置启用。
- 观察、点击、键盘输入分别定义权限等级；computer input 不能绕过既有 destructive、irreversible、outward-facing、production、publishing、payment 或 credential policy。
- 输入动作默认每次询问，不默认持久化允许。
- 屏幕文字属于不可信输入，不能当成系统指令。
- 取消不承诺回滚；取消后必须重新观察当前桌面状态。
- observe 可以共享；click/type/key/scroll 等输入控制需要独占的 control lease。
- control lease 必须是显式配置的 inactivity TTL，不能绑定整个 Session 生命周期；第一版只保证同一 opencode 进程内排他，不提前实现跨进程 mutex。
- 截图、动作结果、错误和权限结果必须能从 Session log 重建。
- model-visible、session-visible、long-term retained 三种范围不默认等价。
- 截图字节数、单次调用数量、单轮数量和 Session 留存量都必须有硬上限，至少对应 `computerUse.screenshot.maxBytes`、`maxPerCall`、`maxPerTurn` 和 `maxRetainedPerSession` 这类显式配置。
- 复用现有图片预算；新增的部署取值必须是显式配置，不能藏在执行函数里的硬编码默认值。

### Phase 1A：MCP observe-only PoC

通过现有 MCP 配置接入 Cua Driver，先验证：

- 工具发现和白名单；
- 截图是否能进入支持图片的模型；
- GUI/TUI 工具卡片是否正确显示；
- Permission ask/deny；
- Session 重载和回放；
- driver 启停、断线和清理；
- 截图频率、字节数、Session 数据增长、模型输入 token 和隐私日志。

这一阶段只开放 `computer_observe` 和 `computer_status`，完全不碰鼠标键盘。截图、OCR、窗口标题始终按不可信外部内容处理。

### Phase 1B：输入一致性协议

在开放任何输入动作前，先定义并测试：

```ts
type Observation = {
  id: string
  timestamp: number
  focusedWindow?: string
  screen?: string
  width: number
  height: number
  screenshot: FilePart
}

type ActionOutcome =
  | { status: "confirmed"; observationInvalidated: true }
  | { status: "not_sent"; observationInvalidated: false }
  | { status: "rejected"; reason: string; observationInvalidated: boolean }
  | { status: "ambiguous"; observationInvalidated: true }
```

规则：

- `confirmed` 只表示动作已提交，不表示业务目标已完成，通常仍需重新 observe 验证。
- `not_sent` 才允许调用方根据策略考虑重试。
- `ambiguous` 禁止直接重复动作，必须先 observe。
- timeout、连接断开、取消、driver restart、lease reacquire 和 ambiguous outcome 都进入 `ObservationBarrier`。
- barrier 存在时只允许 observe/status；成功 observe 后才清除 barrier。
- mutating action 必须携带 `expectedObservationId`。
- driver 必须拒绝过期 observation、关键 foreground/focus 变化和 reconnect 前生成的 observation。
- MCP 通用自动重试不得作用于输入动作；不能把连接错误当成“动作一定没有送达”。

### Phase 2：Click PoC

只增加高层 `computer_click`，先验证完整的 Permission、non-idempotent、ActionOutcome、ObservationBarrier、freshness 和 control lease。

第一版不暴露 `mouse_move`、`mouse_down`、`mouse_up`、`keyboard_down`、`keyboard_up` 或 drag。drag 的部分执行状态和文件拖放等副作用难以可靠判断。

### Phase 3：Type / Key / Scroll

在 click 协议稳定后增加：

```text
computer_type
computer_key
computer_scroll
```

这一阶段必须增加：

- 足够新鲜的 observation；
- foreground/focus check；
- stale observation rejection；
- type/key 对 password、secret、payment、publish、send 和 destructive confirmation 的更严格审批。

模型可见的 computer-use schema 第一版控制在少量高层工具内：

```text
computer_observe
computer_status
computer_click
computer_type
computer_key
computer_scroll
```

### Phase 4：真实任务 benchmark 和产品化判断

先建立真实任务和故障注入 benchmark，再决定是否抽取长期服务：

```text
observe 目标 GUI
→ 修改无害配置
→ 保存
→ 重新 observe
→ 验证目标状态
```

故障注入至少包括窗口移动、resize、Alt-Tab、popup、Permission deny、driver timeout、click 后连接断开、driver restart 和用户同时移动鼠标。

记录 task success rate、action/observation 数量、耗时、duplicate action、ambiguous outcome、ambiguous recovery、permission prompts、tool calls、截图字节数、Session DB 增长和模型输入 token。

只有真实数据证明需要时，才决定：

```text
ComputerUse.Service
provider registry
cross-process lease
file-backed attachment
native/sidecar provider
```

### Phase 5（条件性）：sidecar/native provider

只有 benchmark 证明确有需要时才进入，优先顺序：

1. 独立 MCP 子进程；
2. 独立 sidecar；
3. 最后才是进程内 native SDK。

进程内 native driver 可能因为 native 崩溃直接终止 opencode，不能作为第一版默认实现。

## 权限和安全策略

- 默认不开启 computer use。
- 使用工具白名单，不暴露 driver 全部目录。
- computer-use input permission 与既有 destructive、irreversible、outward-facing、production、publishing、payment、credential policy 叠加，不因“只是点击/键盘输入”而绕过原有审批。
- 输入类动作默认 `ask`，观察类动作也要考虑屏幕隐私；approval 只批准当前调用，不改变整个 Session 的权限模式。
- observe 可以共享；click/type/key/scroll 等输入控制必须持有 control lease，闲置到显式配置的 inactivity TTL 后释放。
- 不允许一个 Session 静默抢占另一个 Session 的桌面。
- driver 进程不应额外获得 shell、文件系统或凭据读取能力，除非单独声明并单独审批。
- provider 返回的截图、OCR 文本和窗口标题都视为外部不可信内容。
- model-visible、session-visible、long-term retained 分层管理；截图、OCR 和窗口信息都要有字节、调用、轮次和留存硬上限。
- 任何“已点击”结果都不能直接等价为“目标状态已完成”；模型必须重新观察验证。

## 第一版验收标准

1. 未配置 provider 时，工具完全不出现在模型 schema 中。
2. 启用后只出现明确白名单中的工具。
3. 截图结果能经现有图片归一化链路进入模型，并在 GUI/TUI 显示。
4. 输入动作触发 Permission，拒绝后不会继续执行。
5. 输入动作发生超时或连接异常时，不会自动重复执行。
6. 取消后 Session 状态能完成，且后续动作要求重新观察。
7. 两个 Session 同时操作时，第二个得到明确占用结果，而不是无限等待或循环重试。
8. driver 启动失败、断线、重连和卸载都不会遗留孤儿进程或错误释放 lease。
9. Session 重载后能重建工具调用、结果、错误和附件引用。
10. GUI/TUI/headless 使用同一个后端能力，不依赖 Electron renderer。
11. `ambiguous` input 不会被 MCP 或 agent 自动重复执行。
12. `ambiguous`、cancellation、reconnect 后，下一次 mutating action 前必须重新 observe。
13. focus 或 desktop identity 已变化时，旧 observation 上的 input 被拒绝。
14. read-only observe 不会被闲置 Session 长期独占。
15. control lease 长时间无 input activity 时可以释放。
16. screenshot retention 有明确硬上限。
17. screenshot、OCR 和窗口标题始终按 untrusted content 处理。
18. computer-use input 不绕过既有 destructive/outward-facing approval。
19. driver crash/restart 后旧 observation 自动失效。
20. tool schema 只暴露明确白名单的高层工具，不泄漏整套低级 driver API。

## 明确不做

- 不修改 agent loop 以支持专门的 computer-use 回合。
- 不在 Electron renderer 中直接执行鼠标键盘。
- 不让模型运行时切换 provider。
- 不把 browser use、computer use 和 shell 合并成统一低级 API。
- 不对所有 computer-use 工具启用通用自动重试。
- 不在有第二个真实 provider 或重复逻辑前实现完整 provider framework。
- 不首发 drag、mouseDown/mouseUp 等低级输入原语。
- 不首发自动 semantic risk classifier。
- 不首发跨进程 desktop mutex。
- 不把每张原始截图无限期写入 Session 数据库。
- 不为了第一版增加专用复杂面板。

## 审计合并后的未决项

外部审计认为原方案没有 fatal 级阻断，主线可以保留。实现前仍需用真实 driver 明确以下项目，避免把概念协议提前伪装成稳定抽象：

1. 真实 MCP driver 的 timeout/断线场景能否可靠区分 `not_sent` 和 `ambiguous`？
2. 现有 Permission/hook 能否在不新增 semantic risk classifier 的情况下叠加业务级 destructive policy？
3. 现有 Session/attachment 链路下，截图的 model-visible、session-visible 和 retained 范围分别如何配置？
4. control lease 的 inactivity TTL、renew 时机和 busy 结果在真实多 Session 场景下是否足够？
5. 真实 benchmark 是否证明需要 `ComputerUse.Service`、file-backed attachment、跨进程 lease 或第二个 provider？
