# RedCode Web UI

本包是 RedCode 的 SolidJS Web UI。它既可以被 Electron GUI 复用，也可以在浏览器里单独开发。

## 开发（全栈一键启动）

```bash
cd packages/app
bun run dev
```

`script/dev.ts` 会同时启动：

- 后端：`packages/opencode` 的 headless 服务端，默认 `http://localhost:4097`
- 前端：Vite dev server，默认 `http://localhost:5173`

端口可用 `RC_SERVER_PORT` / `RC_VITE_PORT` 覆盖。只启动 Vite（`bun run start` 或
`bunx vite`）不会拉起后端，页面需要另开一个 4097 的后端，否则请求会失败。

## 构建

```bash
bun run build
```

产物在 `dist/`，供 GUI 打包或静态托管使用。

## E2E 测试

Playwright 会自行拉起 Vite dev server。E2E 有独立的端口默认值（与 `bun run dev` 不同）：
Vite `3000`、后端 `4096`，都可用环境变量覆盖。

```bash
bunx playwright install chromium
bun run test:e2e:local
bun run test:e2e:local -- --grep "settings"
```

环境选项：

- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT`（后端地址，默认 `localhost:4096`）
- `PLAYWRIGHT_PORT`（Vite dev server 端口，默认 `3000`）
- `PLAYWRIGHT_BASE_URL`（覆盖 base URL，默认 `http://localhost:<PLAYWRIGHT_PORT>`）
