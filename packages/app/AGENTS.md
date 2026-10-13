## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Commands

- `bun run typecheck` (from `packages/app`)
- Dev: `bun run dev` (from `packages/app`)
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4097`
- Open `http://localhost:5173` to verify UI changes (it targets the backend at `http://localhost:4097`).
- `redcode web` starts a local server and opens the local web UI — it proxies nothing hosted.
- 单测：全量 `bun run test:unit`；**跑单个文件用 `bun run test:one <file>`**——`test:unit` 写死 `./src`，追加路径参数会被 bun test 当并集（全量照跑，261011 实证），`test:one` 不带目录、路径完全由参数给。

## Testing

- **`mock.module` 必须静态 import 真模块展开**（文件顶部 `import * as m from "..."`，工厂返回 `{...m, 覆盖项}`）：bun 的 factory `original` 实参是 undefined，手工枚举导出面必然残缺——mock 是进程级全局替换，同进程后加载的测试文件会消费到残缺 mock，链接期 `Export named X not found` 直接崩（报错指向真实 dist 路径，极具迷惑性；指纹=单文件绿、全量挂）。行为性替换（如同步版 `createEffect`）同样会泄漏，功能性替身改用真 solid-js `createRoot` + signal 驱动。261003/261012 两犯，详见全局记忆 #658。

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use the `webqa` MCP server (configured in `seed/redcode.home.jsonc`, enabled by default):
`webqa_screenshot` 截图、`webqa_interact` 驱动点击/输入/eval（Playwright headless）。
旧 `browsermcp` 已移除，There is no `agent-browser` CLI in this repo.
