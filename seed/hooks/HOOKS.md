# RedCode Hooks 生命周期约定

ECC 有 hook 系统，OpenCode 没有原生 hooks。这里定义 RedCode 的 hooks 约定——部分由 plugin 自动执行，部分由 agent 手动遵守。

## 生命周期

| 阶段 | 触发时机 | 执行者 | 行为 |
|------|---------|--------|------|
| **SessionStart** | 每次对话启动 | Plugin + Agent | 注入最近记忆、项目类型、profile |
| **PreToolUse** | 每次工具调用前 | Agent | 检查 gateguard、profile 许可 |
| **PostToolUse** | 每次工具调用后 | Plugin | 追踪编辑文件 |
| **PreCompact** | Context 压缩前 | Agent | 保存当前状态到 `.session-last.json` |
| **Stop** | 对话结束/收工 | Agent | 提取教训、更新长期库 |
| **Compact** | Plugin 处理压缩 | Plugin | 注入关键上下文到压缩后空间 |

## Agent 手动遵守的部分

### SessionStart

```
1. 检查 ECC_MEMORY_RECENT（已在 shell.env 注入）
2. 把最近教训放在思考开头
```

### PreCompact

```
1. 写 .opencode/memory/.session-last.json
2. 格式见 memory-automation skill
```

### Stop

```
1. 从当日日志摘关键教训
2. 去重合入 .opencode/MEMORY.md
3. 删过时条目
```

## Plugin 自动处理的部分

- `shell.env` → 注入 ECC_VERSION / ECC_MEMORY_RECENT / ECC_MEMORY_LONG
- `tool.execute.after` → 追踪 edited files
- `experimental.session.compacting` → 保存变更文件列表到压缩后上下文
- `permission.ask` → 根据 profile 自动批准/拒绝

## 扩展

设计上保持 OpenCode 原生兼容，不引入自建 hook runner。如果将来 OpenCode 支持 hooks，可以直接映射。
