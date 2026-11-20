// 260812 Red GUI dev 一键启动：独立后端端口 + vite 前端，与打包 GUI（exe 占 4096）完全隔离。
// 用法：bun run dev（packages/app 下）。后端端口/前端端口可用 RC_SERVER_PORT / RC_VITE_PORT 覆盖。
import { spawn, spawnSync } from "bun"
import { join } from "node:path"

const appRoot = join(import.meta.dir, "..")
const repoRoot = join(appRoot, "..", "..")
// 261119 Red 后端在 packages/redspace（旧引擎目录已删，此前 GUI dev 一直起不来后端）。
const backendDir = join(repoRoot, "packages", "redspace")

const VITE_PORT = process.env.RC_VITE_PORT ?? "5173"
const SERVER_PORT = process.env.RC_SERVER_PORT ?? "4097"
const CORS = `http://localhost:${VITE_PORT}`

const backend = spawn(
  ["bun", "run", "--conditions=browser", "./src/index.ts", "serve", "--port", SERVER_PORT, "--cors", CORS],
  { cwd: backendDir, stdio: ["ignore", "inherit", "inherit"] },
)

const frontend = spawn(["bun", "x", "vite", "--port", VITE_PORT], {
  cwd: appRoot,
  env: { ...process.env, VITE_REDCODE_SERVER_PORT: SERVER_PORT },
  stdio: ["ignore", "inherit", "inherit"],
})

let shuttingDown = false
function cleanup() {
  if (shuttingDown) return
  shuttingDown = true
  for (const p of [backend, frontend]) {
    if (p.pid) spawnSync(["taskkill", "/F", "/T", "/PID", String(p.pid)], { stdio: "ignore" })
  }
  process.exit(0)
}

process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)
backend.exited.then(cleanup)
frontend.exited.then(cleanup)
