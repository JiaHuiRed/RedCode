# PreToolUse 阻塞钩子 —— 设计方案

> `DESIGN-pre-tool-use.md` — 基于 E:\AI\grok-build (xai-grok-hooks) 的 PreToolUse 模式，为 RedCode 添加工具调用前置拦截钩子。
> 日期：260717

---

## 一、当前现状

### 1.1 已有什么

| 层 | 内容 | 状态 |
|---|---|---|
| 外部插件 SDK (`packages/plugin/src/index.ts`) | `tool.execute.before` / `tool.execute.after` 接口声明 | **已定义但从未触发**（dead signature） |
| 内部 HookSpec (`packages/core/src/plugin.ts`) | 7 个 hook：catalog.transform、account.switched、aisdk.sdk/language、agent.update/remove/default | 正常使用 |
| Plugin trigger 调度器 (`packages/core/src/plugin.ts`) | `trigger(name, input, output)` + Immer draft | 正常使用 |

### 1.2 缺什么

- PreToolUse 事件的 **input/output 类型未定义**（`"tool.use.pre"` 不在 HookSpec 中）
- 没有人 **trigger** 这个事件
- 没有 **阻塞语义**（现在的 trigger 不关心返回值）
- 没有 **文件级 JSON 配置发现**（这是下一阶段的事）

### 1.3 执行流（重点）

工具调用的完整链路：

```
LLM 模型 ◄──► AI SDK (streamText)
                     │
                     ▼
              request.ts (resolveTools → AI SDK Tool[])
                     │
                     ▼
              llm.stream(streamInput)
                     │
                     ▼  AI SDK 内部执行 tool.execute()
              processor.ts (handleEvent)
                     │
               ┌─────┴──────┐
               │            │
         tool-call      tool-result
         (记录调用)     (处理结果)
```

**关键发现**：AI SDK (`ai` package) 的 `streamText` 接收 `tools: Record<string, Tool>` 并在其内部调用 `execute`。processor.ts 的 `handleEvent` 收到的 `tool-call` 事件时，AI SDK **已经决定要执行该工具**。

**拦截位置必须是 `execute` 函数本身**——在它传给 AI SDK 之前包装一层。

---

## 二、设计方案

### 2.1 新增 Hook 定义

**文件**：`packages/core/src/plugin.ts` — 追加到 `HookSpec`

```typescript
"tool.use.pre": {
  input: {
    toolID: string
    args: Record<string, unknown>
    sessionID: string
    agent: string
  }
  output: {
    denied: boolean
    reason?: string       // 仅 denied=true 时有意义
    overrides?: Record<string, unknown>  // 可选的参数覆写
  }
}

"tool.use.post": {
  input: {
    toolID: string
    args: Record<string, unknown>
    sessionID: string
    agent: string
    duration: number       // 执行耗时 ms
    success: boolean
    output?: string        // success=true 时
    error?: string         // success=false 时
  }
  output: {}
}
```

### 2.2 拦截点实现

**文件**：`packages/opencode/src/tool/registry.ts` — 在 `tools()` 函数中包装 execute

当前（简略）：
```typescript
const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
  const filtered = (yield* all()).filter(...)
  return yield* Effect.forEach(
    filtered,
    function* (tool) {
      // ...tool.definition hook...
      return {
        id: tool.id,
        description: ...,
        parameters: ...,
        execute: tool.execute,  // ← 直接透传
      }
    },
  )
})
```

修改后：
```typescript
const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
  const filtered = (yield* all()).filter(...)
  return yield* Effect.forEach(
    filtered,
    function* (tool) {
      // ...tool.definition hook...

      const originalExecute = tool.execute
      const wrappedExecute: typeof originalExecute = (args, ctx) =>
        Effect.gen(function* () {
          // === PreToolUse Hook ===
          const output = { denied: false as boolean, reason: undefined as string | undefined }
          try {
            yield* plugin.trigger("tool.use.pre", {
              toolID: tool.id,
              args: args as Record<string, unknown>,
              sessionID: ctx.sessionID,
              agent: ctx.agent,
            }, output)
          } catch (e) {
            // Fail-open: hook 崩溃不阻塞工具
            using _ = log.error("hook.pre-tool-use.error", { tool: tool.id, error: e })
          }

          if (output.denied) {
            return {
              title: "Blocked",
              output: `Tool "${tool.id}" was blocked by hook.${output.reason ? ` Reason: ${output.reason}` : ""}`,
              metadata: { blocked: true, blockedBy: "hook.pre-tool-use" },
            }
          }
          // =========================

          return yield* originalExecute(args, ctx)
        }).pipe(
          Effect.withSpan("Tool.execute.wrapped", {
            attributes: { "tool.name": tool.id, "hook.pre-tool-use": true },
          }),
        )

      return {
        id: tool.id,
        description: ...,
        parameters: ...,
        execute: wrappedExecute,  // ← 替换为包装版本
      }
    },
  )
})
```

### 2.3 插件 SDK 对齐

**文件**：`packages/plugin/src/index.ts` — 更新 `Hooks` 接口

当前已有的 `"tool.execute.before"` 改为底层调用 `"tool.use.pre"` 实现，并增加 `denied` 语义：

```typescript
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any; denied: boolean; reason?: string },  // 新增 denied
) => Promise<void>
```

> 兼容性：增加 `denied?: boolean` 字段不会破坏已有插件（undefined = false）。

### 2.4 多钩子冲突策略

| 情况 | 行为 |
|---|---|
| 0 个钩子 | 正常执行 |
| ≥1 个钩子，全部放行 | 正常执行 |
| ≥1 个钩子，首个 deny | **短路**停止后续钩子，立即拒绝（同 grok-build） |
| 钩子崩溃 | fail-open，放行 |

实现上：`plugin.trigger` 目前是顺序遍历所有注册钩子。当 `output.denied` 变为 `true` 时，**不停止遍历**（当前实现不支持中间短路），只是记录第一个 deny 的原因。

可选优化：在 trigger 中加入短路逻辑——检查 output.denied 后跳过剩余钩子。但初期没必要，按"先简单再优化"原则。

---

## 三、破坏性分析

### 3.1 不改的部分

| 模块 | 状态 |
|---|---|
| `packages/core/src/plugin.ts` | 追加 HookSpec 条目，不改任何逻辑 |
| `packages/opencode/src/session/processor.ts` | 不动 |
| `packages/opencode/src/session/llm/request.ts` | 不动 |
| AI SDK (`ai` package) | 不动 |
| 工具定义 (`tool/tool.ts`) | 不动 |
| 现有 hook trigger 调用方 | 不动 |
| 外部插件接口 (`packages/plugin/src/index.ts`) | 加可选字段，向后兼容 |

### 3.2 改的部分

| 文件 | 改动量 | 说明 |
|---|---|---|
| `packages/core/src/plugin.ts` | +6 行 | HookSpec 新增 2 个事件定义 |
| `packages/opencode/src/tool/registry.ts` | ~+30 行 | `tools()` 中 wrap execute |
| `packages/plugin/src/index.ts` | +2 行 | `tool.execute.before` 加 `denied` 字段 |

### 3.3 潜在风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| Hook 崩溃导致工具执行失败 | 低 | fail-open，catch 后记日志继续执行 |
| wrap 影响 AI SDK 工具调用时序 | 极低 | wrap 在 return 前执行，同步调用 |
| 多钩子顺序依赖 | 低 | 按注册顺序，首个 deny 短路 |
| `denied` 新字段被旧插件覆盖 | 低 | Immer draft 模式下，不设 `denied` 则维持 false |
| 性能影响 | 极低 | trigger 只是遍历几个函数调用 |

### 3.4 兼容性

- **向前兼容**：不配钩子 → 行为零变化
- **向后兼容**：升级后已有插件 API 不变
- **外部插件**：`tool.execute.before` 的 `denied` 字段为新增可选字段，undefined = false

---

## 四、实施计划

### Phase 1 — 核心 Hook 定义 + 拦截（0.5 天）

1. `packages/core/src/plugin.ts` — 追加 `"tool.use.pre"`、`"tool.use.post"` 到 HookSpec
2. `packages/opencode/src/tool/registry.ts` — wrap execute，调用 pre-tool-use hook
3. `packages/plugin/src/index.ts` — 对齐 `denied` 字段
4. typecheck 通过

### Phase 2 — 测试

1. `packages/opencode/test/tool/` — 加 PreToolUse 单元测试：
   - 无钩子 → 正常执行
   - 钩子 deny → 返回 blocked 结果
   - 钩子崩溃 → fail-open 执行
   - 多钩子首个 deny → 短路
2. 集成测试：注册一个 shell 守卫钩子，验证危险命令被拦

### Phase 3 — JSON 文件发现（独立、可选）

按 grok-build 的 discovery + config 模式：
- `~/.grok/hooks/*.json` 发现
- 项目 `.grok/hooks/*.json` 发现（需信任）
- HookRunner（脚本执行器）
- 先做 Phase 1+2，Phase 3 后续再议

---

## 五、与 Grok-Build 的设计差异

| 维度 | Grok-Build | RedCode（本方案） |
|---|---|---|
| 钩子来源 | JSON 文件（命令/HTTP） | Effect plugin（程序化）+ 未来文件 JSON |
| 拦截层 | 独立子进程/HTTP | wrap execute 函数 |
| 阻塞机制 | 子进程 stdout JSON `decision` | Effect trigger output.denied |
| fail-open | 崩溃/超时 → 放行 | catch → 放行 |
| 匹配器 | 精确/正则/别名展开 | 暂不做；由 hook 实现者自行判断 |
| PreToolUse 输入 | 完整 HookEventEnvelope | toolID + args + sessionID + agent |
| 执行者安全 | 子进程隔离 | 同进程（后续可做隔离） |
