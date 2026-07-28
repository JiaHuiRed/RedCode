## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Commands

- `bun run typecheck` (from `packages/app`)
- Dev: `bun dev -- --port 4444`
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- Open `http://localhost:4444` to verify UI changes (it targets the backend at `http://localhost:4096`).
- `redcode web` starts a local server and opens the local web UI — it proxies nothing hosted.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use the `browsermcp` MCP server (configured in `.opencode/redcode.home.jsonc`, disabled by default —
enable it there when you need it). There is no `agent-browser` CLI in this repo.
