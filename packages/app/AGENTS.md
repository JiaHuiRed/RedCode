## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Commands

- `bun run typecheck` (from `packages/app`)
- Dev: `bun run dev` (from `packages/app`)
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4097`
- Open `http://localhost:5173` to verify UI changes (it targets the backend at `http://localhost:4097`).
- `redcode web` starts a local server and opens the local web UI — it proxies nothing hosted.
- 单测：全量 `bun run test:unit`；**跑单个文件用 `bun run test:one <file>`**——`test:unit` 写死 `./src`，追加路径参数会被 bun test 当并集（全量照跑，261011 实证），`test:one` 不带目录、路径完全由参数给。

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use the `webqa` MCP server (configured in `seed/redcode.home.jsonc`, enabled by default):
`webqa_screenshot` 截图、`webqa_interact` 驱动点击/输入/eval（Playwright headless）。
旧 `browsermcp` 已移除，There is no `agent-browser` CLI in this repo.
