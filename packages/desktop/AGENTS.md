> 本包 = **GUI**（`packages/desktop`），对应人格 **GUI 助手**。在此工作即 GUI 的主场。

# Desktop package notes

- Renderer process should only call `window.api` from `src/preload`.
- Main process should register IPC handlers in `src/main/ipc.ts`.

## Commands

- `bun run typecheck` (from `packages/desktop`)
- `bun run build` → `bun run package`（打包 electron 安装包）
- `bun run dev`（electron-vite 开发模式）
