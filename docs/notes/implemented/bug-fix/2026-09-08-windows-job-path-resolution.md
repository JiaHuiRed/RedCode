# Windows Job runner 交给 PATH 解析裸 MCP 命令

状态:implemented

## 问题

Windows+Bun 的 MCP stdio 启动改走原生 Job runner 后，`node`、`bun`、`markitdown-mcp`、`fff-mcp` 等配置里的裸命令全部启动失败，只有绝对路径的 jcodemunch 能连接。`where.exe` 能找到这些命令，说明 PATH 本身没有缺失。

根因是 `CreateProcessW` 同时传入了非空的 `lpApplicationName` 和裸命令。Windows 在 `lpApplicationName` 非空时不会替调用方做 PATH 搜索，runner 只把错误收敛成 MCP 的 `Connection closed`。

## 决策

在 `packages/opencode/src/util/windows-job-runner.ts` 中将 `lpApplicationName` 设为 `null`，保留带引号的完整命令行，让 Windows 使用正常的可执行文件搜索规则；Job 对象、stdio 继承和进程树回收逻辑不变。

同时让 `WindowsJobStdioClientTransport` 监听 target 的退出错误，并用裸 `node` 做真实 JSON-RPC 握手回归，避免只测 runner 能启动。

## 备选与否决理由

- **把所有 MCP 配置改成绝对路径**：否决——机器相关、无法随模板同步，且掩盖了进程层根因。
- **自己调用 `SearchPathW` 再传绝对路径**：否决——重复 Windows 的既有解析规则，增加扩展名、环境和错误处理面。
- **恢复普通 `cross-spawn`**：否决——会失去 Job 对 detached descendant 的统一回收能力。

## 后果

- 裸命令可以继续保留在共享配置中，路径解析交给 Windows。
- 已运行的旧 `redcode.exe` 不会热加载新 runner；需要正常重启后，新的 TUI 构建才会生效。
- 验收信号：Windows 上 `bun test --timeout 30000 test/mcp/stdio.test.ts` 的裸 `node` JSON-RPC 测试通过。
