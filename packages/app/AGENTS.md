## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Commands

- `bun run typecheck` (from `packages/app`)
- Dev: `bun dev -- --port 4444`
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- Open `http://localhost:4444` to verify UI changes (it targets the backend at `http://localhost:4096`).
- `opencode dev web` proxies `https://app.redcode.dev`, so local UI/CSS changes will not show there — use local dev above.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
