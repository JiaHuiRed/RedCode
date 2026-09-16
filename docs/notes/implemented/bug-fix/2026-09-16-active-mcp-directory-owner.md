# Active MCP directory follows one route owner and clears on home

状态: implemented

## 问题

`activeMcpDirectory` 定义在 global-sync 中，却由 `SessionPage` 和 `Titlebar` 两处写入；两处都只在目录存在时赋值，回到首页后不会清空。不同页面生命周期和多项目切换可能让 query 继续以旧目录为 active。

## 决策

- `Layout` 依据唯一的 `currentDir()`（当前路由解析出的真实目录）写入 `activeMcpDirectory`。
- `currentDir()` 为空时写入空字符串，回到首页不启用任何项目级 MCP/path/LSP/provider query。
- `Titlebar` 与 `SessionPage` 只消费路由/状态，不再写入 global-sync signal。
- `Layout` 卸载时清空 signal，避免旧 renderer 生命周期留下 active 目录。

## 备选与否决理由

- **在两个旧 writer 中各自补 clear 分支**：否决——仍然保留多 owner，切换顺序会继续影响最终值。
- **新增全局 store/provider**：否决——现有 signal 已足够，问题是 owner 不清晰而不是状态容器不足。

## 后果

MCP query 的启停与路由一致，项目 A → 项目 B → 首页的状态转换只由 Layout 驱动。测试覆盖 active 目录从项目值回到空值的清理契约。
