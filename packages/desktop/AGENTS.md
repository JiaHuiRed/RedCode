> 本包 = **GUI**（`packages/desktop`）：Electron main/renderer、sidecar 与打包入口。
> 人格/身份由会话绑定的 Soul 决定，不按客户端或目录指定。

# Desktop package notes

- Renderer process should only call `window.api` from `src/preload`.
- Main process should register IPC handlers in `src/main/ipc.ts`.

## Commands

- `bun run typecheck` (from `packages/desktop`)
- `bun run build` → `bun run package`（打包 electron 安装包）
- `bun run dev`（electron-vite 开发模式）
