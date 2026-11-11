# MCP 真懒启动与工具目录稳定化：从 codex 195 commits 借的两个设计

状态：implemented（方案 A 已落地 261111；方案 B 未开始）

日期：2026-11-11
来源：`E:\AI\codex`（HEAD `5228d94a27`）2026-11-06..11-11 的 195 个 commit

## 问题

八个常开 MCP 的用量极不均衡（`redcode.db` part 表，近 30 天，共 409 个活跃会话）：

| MCP | 30 天调用 | 覆盖会话 | 备注 |
| --- | --- | --- | --- |
| jcodemunch | ~2,220 | 296 | 主力 |
| fff | 2,033 | 110 | 主力 |
| webqa | 1,688 | 60 | 前端调试刚需 |
| mcp-process-mgmt | 725 | 51 | 长驻进程刚需 |
| indexgraph | 83 | 22 | 单文件 HTML 专用 |
| web-search | 67 | — | 低频 |
| markitdown | 6 | — | 极低频 |
| su-prememory | 3 | — | 极低频 |
| chrome-devtools | 0（末次 08-12） | 0 | 已闲置 |

后三个（markitdown / su-prememory / chrome-devtools）合计 30 天 9 次调用，但**每次启动仍然 spawn 进程并握手**。chrome-devtools 挂了两个月零调用，纯粹是启动开销。

现有缓解只到"不阻塞首屏"这一层：`mcp/index.ts:1029-1081` 的 `connectAll` 用 1.5 秒宽限期，超出的后台继续连（注释里记着 2026-08-31 那次实测 13 秒首屏卡顿）。**但进程照样起、握手照样做、失败重试照样跑**——省的是等待，不是成本。

## codex 的做法

### 1. `mcp_lazy_stdio_startup`（commit `af9a98b074`，#60039）

> Regular chats start MCP servers eagerly even when cached tool definitions are available and the servers go unused. Allow those chats to use the cached catalog and defer eligible stdio servers until first use.

实现上的三个约束值得抄：

- **分级**：只对 `startup_readiness = "catalog"` 的服务器允许 defer；需要 live 启动连接的保持 eager。显式 reconnect 永远 eager。
- **缓存目录先用**：deferred 服务器的工具定义从缓存直接进工具表，模型看不到"少了一组工具"。
- **状态可见**：启动摘要排除 dormant 服务器，TUI 让它们在后续轮次独立上报"我启动了"，避免用户以为服务器挂了。

配套两条（#60038 / #60037）：缓存调用准备失败时**要报错而不是静默**；延迟启动不能破坏 MCP 的共享发现。

### 2. 工具目录作为增量 world state（commit `55897425e8` / `2bc8e7f545` / `60163` 等）

`codex-rs/core/src/context/world_state/top_level_tools.rs` 头注释：

> Diffs the one-level Responses Lite catalog: namespaces of callable tools and built-ins. Missing state starts a fresh catalog; this section does not migrate legacy history. One developer notice precedes each incremental namespace batch; catalog hashes are unchanged. Whole namespace removals subsume their members in the removal notice.

即：工具目录不再每轮全量重发，而是作为历史里的状态段做 diff（新增发 developer notice、变更发完整替换、删除发通知，删整个 namespace 时成员并入一条）。`exec` 不可用时保留 entry hash，恢复后对齐。测试里专门断言 "incremental requests preserve input prefixes"。

## 我们的现状（已实现 vs 缺失）

已经有的，不要重复造：

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| MCP 工具磁盘缓存（tools + instructions） | `mcp/index.ts:49-88` | 未连接时用缓存定义进工具表 |
| cache-first 工具表 | `mcp/index.ts:1464-1498` | 服务器未连上时注入 `convertMcpToolCached` stub |
| stub 有界等待连接 | `mcp/index.ts:508-541` | 等待连接后走与 live 相同的调用体 |
| 工具描述钉住 + overlay | `session/prompt.ts` `overlayToolDefs` + `prompt-pin.ts` | 描述漂移不打掉前缀 |
| instructions 上限 | `mcp/index.ts:90-114`（单项 2000 / 合计 8192） | 第三方文本有硬上限 |
| 启动宽限 1.5s + 后台连接 | `mcp/index.ts:1049-1081` | 不阻塞首屏 |

缺的只有一步：**`serverWaitConnected`（`mcp/index.ts:494`）只轮询状态、不会触发 create**，注入的 stub（`:508-541`）拿到的 `waitUntilConnected` 就是纯 wait。所以 deferred 服务器在没有后台连接的情况下会等到超时然后报 "not connected"。

## 决策

### A. 真懒启动（P0）

新增配置字段，默认保持现状（动现有行为的事不做隐式）：

```jsonc
"mcp": {
  "markitdown": { ..., "startup": "lazy" }
}
```

`startup: "eager"`（默认）| `"lazy"`。`lazy` 生效需要两个条件同时满足，否则自动降级 eager：

1. 磁盘缓存存在且非空（`readMcpToolsCache` 有内容）
2. 服务器类型是 `local`（远程/需要 OAuth 的保持 eager，握手本身就是认证）

实现：

- `connectAll` 跳过 lazy 服务器，`s.status[name] = { status: "deferred" }`
- `tools()` 的 cache-first 分支把 `deferred` 当作未连接处理（现有逻辑天然覆盖）
- `serverWaitConnected` 增加一个按需触发：状态是 `deferred` 时先 `createAndStoreInState`（已有的并发锁会防重复创建），再进轮询
- 首次调用失败且错误是 "unknown tool" 时，强制重连一次再报错——缓存定义可能落后于服务器升级（对应 codex #60038 的"报错不要静默"）
- 状态展示区分 `deferred` / `connecting`，UI 上不显示成"连接失败"

### B. 工具目录冻结（P1，待 A 上线后再评估）

codex 的响应是"在历史里增量声明工具变更"，前提是它自己控制 wire 格式（Responses Lite）。我们每轮向供应商发全量 `tools` 数组，**没有这个控制点**——工具集合一变，tools 段及其后的所有消息全部作废（前缀从 tools 开始失效）。

所以只有两个选择：

- 维持现状：依赖 `overlayToolDefs` 钉描述 + cache-first 保证集合稳定
- 加 `experimental.freeze_tool_set`：会话首轮定死集合，后续新增工具不注入（只记日志）

建议先做 A 并观察：A 让"缓存即完整集合"，集合稳定性大部分已经解决。B 只在实测仍有频繁工具表抖动时再做。

## 备选与否决理由

- **Responses-style 增量 tool 声明**：否决——wire 层在供应商手里，OpenAI 的 `incremental_tools` 不是 Chat Completions 的公开字段，我们无法表达"这次只改 namespace B"。
- **彻底不 spawn 未声明的 MCP（默认 lazy）**：否决——默认值改变会让"首次调用等 3-10 秒连接"变成所有人的体验，而大多数服务器（jcodemunch/fff/webqa）本来就是主力，eager 更划算。必须按服务器显式选择。
- **用 pin 里的工具表完全替代 live defs**：否决——服务器升级删了工具后，模型会一直调用不存在的工具；只能作为"启动窗口内的临时"存在。

## 后果

- 收益：3 个低频 MCP 不 spawn（进程数 8→5），省启动握手的 CPU/内存；chrome-devtools 这类零调用服务器彻底不启动。
- 代价：lazy 服务器首次调用要等连接（30s 单步超时内），期间该工具调用是阻塞的；缓存过期的工具名会产生一次失败调用。
- 识别签名：日志里出现 `MCP startup exceeded its budget` 且服务器配置为 lazy，说明缓存判定或按需 create 没生效。
- 验证计划：`test/mcp/lifecycle.test.ts` 加 lazy 分支用例（跳过 create、缓存工具可用、首次调用触发创建）；真机量启动到首屏时间、MCP 进程数、首次调用延迟，与现状对照。

## 落地记录（261111）

- 配置：`config/mcp.ts` 的 Local 增加 `startup: "eager" | "lazy"`。
- 状态：`mcp/index.ts` 的 `Status` 增加 `deferred`；`connectAll` 对它跳过 spawn；状态展示（`cli/cmd/mcp.ts`、`cli/cmd/doctor.ts`）单独分支——既不算失败也不算连接中。
- 按需连接：`serverWaitConnected` 接受可选 `ensure`，首个调用在 `deferred` 状态时触发一次 `connect()`，复用既有并发锁与退避清理。
- 回链：`shouldDeferStartup` 与 `connectAll` 的注释指向本文。
- 测试：`test/mcp/lifecycle.test.ts` 新增三例（有缓存不 spawn、无缓存降级 eager、首次调用触发创建），34 pass / 0 fail；`bun run typecheck` 0；OpenAPI 已重新生成。
- 待补：真机量启动到首屏时间与 MCP 进程数（预期 8→5；需在用户配置里给 markitdown / su-prememory / chrome-devtools 加 `startup: "lazy"`）、首次调用延迟。
