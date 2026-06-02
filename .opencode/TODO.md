# RedCode 未来版本规划

> 从 ECC（多 AI agent 模式）项目中提取的改进方向。拉取 ECC 后参考这些方向开工。

---

## v0.3.14 — 上下文压力检测

**来源**: ECC 的 Counter hooks 模式

**目标**: 检测 AI 上下文是否接近 token 上限，提前预警或自动压缩

### 实现方向

1. **ContextPressureCounter Hook** (`use-context-pressure.ts`)
   ```ts
   // 监控 token 使用量 vs 上下文限制
   // 当使用率 > 80% 时发出警告
   // 当使用率 > 95% 时自动触发压缩
   function useContextPressure(sessionId: string) {
     const usage = createMemo(() => ...)
     const pressure = createMemo(() => usage() / limit())
     const isWarning = createMemo(() => pressure() > 0.8)
     const isCritical = createMemo(() => pressure() > 0.95)
     return { pressure, isWarning, isCritical, usage, limit }
   }
   ```

2. **集成到 PromptInput**
   - 压力指示器：在输入框下方显示进度条
   - 颜色渐变：绿（<60%）→ 黄（60-80%）→ 红（>80%）
   - 点击展开详情：显示 token 使用分布（用户/助手/工具/系统）

3. **自动压缩触发**
   - 当 `isCritical` 为 true 时，自动调用压缩 API
   - 压缩策略：保留最近 N 条消息 + 系统提示 + 工具定义
   - 压缩后 toast 通知："上下文已自动压缩，释放了 X tokens"

4. **会话列表显示压力**
   - Home 页面 session 列表项显示压力指示器
   - 高压力 session 用红色/黄色标记

### 涉及文件

- `packages/app/src/hooks/use-context-pressure.ts`（新）
- `packages/app/src/components/prompt-input.tsx`（修改）
- `packages/app/src/pages/session.tsx`（集成）
- `packages/app/src/pages/home.tsx`（session 列表显示）

---

## v0.3.15 — 5 层 Error Hierarchy

**来源**: ECC 的错误处理模式

**目标**: 统一错误处理，提供更好的用户反馈

### 5 层错误分类

| 层 | 类型 | 用户行为 | 示例 |
|----|------|----------|------|
| L1 | 网络错误 | 重试 | API 超时、DNS 解析失败 |
| L2 | 认证错误 | 检查配置 | API Key 无效、Token 过期 |
| L3 | 限额错误 | 等待/升级 | Rate limit、Quota exceeded |
| L4 | 模型错误 | 换模型/重试 | Context length exceeded、Model unavailable |
| L5 | 系统错误 | 联系支持 | 内部服务错误、未知异常 |

### 实现方向

1. **ErrorClassifier** (`utils/error-classifier.ts`)
   ```ts
   function classifyError(error: unknown): ErrorLevel {
     if (isNetworkError(error)) return { level: 1, retryable: true }
     if (isAuthError(error)) return { level: 2, retryable: false }
     if (isQuotaError(error)) return { level: 3, retryable: true, retryAfter: ... }
     if (isModelError(error)) return { level: 4, retryable: true }
     return { level: 5, retryable: false }
   }
   ```

2. **ErrorToast 组件**
   - 根据错误级别显示不同颜色和操作按钮
   - L1: 黄色 toast + "重试" 按钮
   - L2: 红色 toast + "检查配置" 按钮
   - L3: 橙色 toast + "等待 X 分钟" 倒计时
   - L4: 紫色 toast + "切换模型" 按钮
   - L5: 红色 toast + "复制错误信息" 按钮

3. **错误恢复策略**
   - 自动重试：L1 错误最多重试 3 次，间隔递增（1s, 2s, 4s）
   - 降级处理：L4 错误时自动切换到备用模型（如果配置了）
   - 用户干预：L2/L3 错误时暂停并提示用户

4. **错误日志上报**
   - L5 错误自动上报到 Sentry（如果配置了）
   - 错误上下文：session ID、消息 ID、模型、token 使用量

### 涉及文件

- `packages/app/src/utils/error-classifier.ts`（新）
- `packages/app/src/components/error-toast.tsx`（新）
- `packages/app/src/context/error-recovery.ts`（新）
- `packages/app/src/hooks/use-error-handler.ts`（新）

---

## v0.3.16 — Tool Registry 重构

**来源**: ECC 的工具注册模式（大改）

**目标**: 统一工具定义、发现、调用流程，支持动态工具加载

### 实现方向

1. **ToolRegistry 中央注册表**
   ```ts
   class ToolRegistry {
     private tools = new Map<string, ToolDefinition>()
     
     register(tool: ToolDefinition) { ... }
     unregister(name: string) { ... }
     get(name: string) { ... }
     list(): ToolDefinition[] { ... }
     byCategory(category: string): ToolDefinition[] { ... }
   }
   ```

2. **ToolDefinition 类型**
   ```ts
   interface ToolDefinition {
     name: string
     category: 'file' | 'search' | 'terminal' | 'web' | 'mcp' | 'custom'
     description: string
     parameters: JSONSchema
     execute: (params: any) => Promise<ToolResult>
     permissions: PermissionRequirement[]
     rateLimit?: { maxCalls: number; windowMs: number }
   }
   ```

3. **动态工具发现**
   - MCP 工具自动注册到 ToolRegistry
   - 插件工具通过配置文件声明
   - 运行时可动态加载/卸载工具

4. **工具调用链可视化**
   - Debug 模式显示工具调用树
   - 每个工具调用显示耗时、token 消耗
   - 支持导出调用链为 JSON

### 涉及文件

- `packages/opencode/src/tool/registry.ts`（新）
- `packages/opencode/src/tool/definition.ts`（新）
- `packages/app/src/components/debug-bar.tsx`（修改：显示工具调用链）

---

## v0.3.17 — Prefetch 空闲调度

**来源**: ECC 的 requestIdleCallback 模式

**目标**: 利用浏览器空闲时间预取 session 数据，减少用户等待

### 实现方向

1. **IdleScheduler** (`utils/idle-scheduler.ts`)
   ```ts
   function scheduleIdleTask(task: () => void, priority: 'high' | 'medium' | 'low') {
     if ('requestIdleCallback' in window) {
       requestIdleCallback(task, { timeout: priority === 'high' ? 1000 : 5000 })
     } else {
       setTimeout(task, 0)
     }
   }
   ```

2. **SessionPrefetch 重构**
   - 当前：立即 prefetch 相邻 session
   - 重构：利用空闲时间 prefetch
   - 优先级：当前 session > 相邻 session > 其他 session

3. **预取策略**
   - 高优先级：当前 session 的下一条消息
   - 中优先级：相邻 session 的元数据
   - 低优先级：其他 session 的消息列表

4. **性能监控**
   - 记录 prefetch 命中率
   - 记录空闲时间利用率
   - Home 页面显示 "预取状态" 指示器

### 涉及文件

- `packages/app/src/utils/idle-scheduler.ts`（新）
- `packages/app/src/context/global-sync/session-prefetch.ts`（修改）
- `packages/app/src/pages/session.tsx`（修改：集成空闲调度）

---

## v0.3.18 — 会话压缩策略

**来源**: ECC 的上下文管理模式

**目标**: 智能压缩历史会话，保留关键信息

### 实现方向

1. **压缩策略选择**
   - 策略 1：保留最近 N 条消息（简单）
   - 策略 2：保留重要消息（基于 token 消耗排序）
   - 策略 3：语义压缩（调用 LLM 生成摘要）
   - 策略 4：混合策略（最近 + 重要 + 摘要）

2. **CompressionManager**
   ```ts
   class CompressionManager {
     async compress(messages: Message[], strategy: CompressionStrategy): Promise<Message[]> {
       switch (strategy) {
         case 'recent': return this.compressByRecent(messages, 10)
         case 'important': return this.compressByImportance(messages, 0.7)
         case 'semantic': return this.compressBySemantic(messages)
         case 'hybrid': return this.compressHybrid(messages)
       }
     }
   }
   ```

3. **压缩触发条件**
   - 手动触发：用户点击 "压缩上下文" 按钮
   - 自动触发：token 使用率 > 90%
   - 预算触发：剩余 token < 10% 时强制压缩

4. **压缩结果展示**
   - 压缩前后对比：显示 token 节省量
   - 压缩后摘要：显示保留的关键信息
   - 撤销支持：压缩后 5 秒内可撤销

### 涉及文件

- `packages/app/src/utils/compression-manager.ts`（新）
- `packages/app/src/components/compression-dialog.tsx`（新）
- `packages/app/src/context/session-compression.ts`（新）

---

## v0.4.0 — 大版本升级（长期规划）

### 1. 多 Agent 协作

- **Agent 通信协议**: 定义 Agent 间消息格式
- **任务分发器**: 主 Agent 分配子任务给子 Agent
- **结果聚合器**: 汇总多个 Agent 的执行结果
- **冲突解决**: 多 Agent 同时修改文件时的冲突处理

### 2. 插件系统

- **插件发现**: 从 npm/github 发现可用插件
- **插件安装**: 一键安装插件到本地
- **插件配置**: 插件配置界面
- **插件沙箱**: 插件运行在隔离环境中

### 3. 云端同步

- **会话同步**: 多设备间同步会话历史
- **配置同步**: 同步 provider/model 配置
- **插件同步**: 同步已安装的插件列表
- **离线支持**: 断网时本地缓存，联网后同步

### 4. 团队协作

- **共享会话**: 团队成员共享会话历史
- **代码审查**: AI 辅助代码审查
- **知识库**: 团队共享的代码知识库
- **权限管理**: 团队成员权限分级

---

## 布局重构（Phase 2/3）

### Phase 2：更激进的清理

- **删除 V1 残留代码**: 已完成（v0.3.13）
- **清理 sidebar 相关 state**: `layout.context` 中的 `sidebar.opened()` 等状态
- **简化 autoselect 逻辑**: V2 不再需要，可删除

### Phase 3：Layout 纯化

- **LayoutShell**: 只负责 JSX 结构
- **LayoutContent**: 所有 hooks 和状态
- **LayoutFooter**: Toast 区域
- **LayoutContext**: 共享状态上下文

### Phase 4：性能优化

- **虚拟滚动**: 长 session 列表虚拟滚动
- **懒加载**: 非活跃 session 懒加载消息
- **Web Workers**: 将计算密集任务移到 Worker
- **WASM 加速**: 将 AST 解析等任务用 WASM 实现

---

## MCP 扩展

### 1. jCodeMunch 深度集成

- **语义搜索**: 基于 embedding 的代码搜索
- **死代码检测**: 自动发现未使用的代码
- **影响分析**: 代码变更影响评估
- **重构建议**: 基于代码质量的重构建议

### 2. Browser MCP 增强

- **多标签页支持**: 同时操作多个标签页
- **表单自动填写**: AI 自动填写表单
- **截图对比**: 自动对比页面变化
- **性能监控**: 页面加载性能分析

### 3. 自定义 MCP 服务器

- **MCP 服务器模板**: 快速创建自定义 MCP 服务器
- **MCP 服务器市场**: 发现和分享 MCP 服务器
- **MCP 服务器测试**: 在线测试 MCP 服务器

---

## 测试补全

### 1. 单元测试

- **工具系统**: ToolRegistry、ToolDefinition 测试
- **错误处理**: ErrorClassifier、ErrorRecovery 测试
- **压缩策略**: CompressionManager 测试
- **空闲调度**: IdleScheduler 测试

### 2. 集成测试

- **会话流程**: 创建 → 发送消息 → 接收响应 → 保存
- **工具调用**: 工具发现 → 权限确认 → 执行 → 结果返回
- **错误恢复**: 网络错误 → 重试 → 成功/失败

### 3. E2E 测试

- **GUI 流程**: 启动 → 登录 → 创建会话 → 发送消息
- **TUI 流程**: 启动 → 选择 provider → 发送消息 → 查看结果
- **MCP 测试**: 启动 MCP 服务器 → 调用工具 → 验证结果

---

## 优先级排序

| 优先级 | 版本 | 内容 | 预估工时 |
|--------|------|------|----------|
| P0 | v0.3.14 | 上下文压力检测 | 2-3 天 |
| P0 | v0.3.15 | 5 层 Error Hierarchy | 3-4 天 |
| P1 | v0.3.16 | Tool Registry 重构 | 5-7 天 |
| P1 | v0.3.17 | Prefetch 空闲调度 | 2-3 天 |
| P1 | v0.3.18 | 会话压缩策略 | 3-4 天 |
| P2 | v0.4.0 | 大版本升级 | 2-3 周 |
| P2 | Phase 2/3 | Layout 纯化 | 3-5 天 |
| P2 | MCP 扩展 | 深度集成 | 1-2 周 |
| P2 | 测试补全 | 测试覆盖 | 1-2 周 |

---

## 快速开始

拉取 ECC 后：

1. **阅读 ECC 源码**: 重点关注 `src/hooks/`、`src/utils/`、`src/context/` 目录
2. **对比 RedCode**: 找出可复用的模式和需要适配的地方
3. **从 P0 开始**: 先做上下文压力检测和错误处理，这两个改动小、收益大
4. **逐步推进**: 每个版本独立，不要一次性做太多

---

## 参考资源

- ECC 项目：`D:\AI\ECC`
- jCodeMunch 文档：`https://github.com/colbymchenry/jcodemunch`
- TypeGraph 文档：`https://github.com/guyowen/typegraph-mcp`
- Browser MCP 文档：`https://github.com/colbymchenry/browsermcp`
