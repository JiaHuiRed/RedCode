# RedCode TUI 核心

本包是 RedCode 的 TUI / 服务端核心（CLI、plugin、MCP、Effect、session）。

## 依赖

从仓库根目录安装：

```bash
bun install
```

## 开发

```bash
# 交互式 TUI（Windows 下用 mcp-process-mgmt 或后台进程跑，不要阻塞前台）
bun run dev

# headless 服务端（GUI / Web UI 的开发后端）
bun run --conditions=browser ./src/index.ts serve --port 4097
```

`bun run index.ts` 不存在——入口在 `src/index.ts`，且必须带 `--conditions=browser`。

## 验证

```bash
bun run typecheck
bun run test:smoke
```
