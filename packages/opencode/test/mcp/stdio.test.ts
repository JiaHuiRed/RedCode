import { expect, test } from "bun:test"
import path from "node:path"

// 261008 Red 真 transport 练习必须在子进程里跑：lifecycle.test.ts 顶层
// mock.module 毒化同进程注册表，本文件若直接 import src/mcp/stdio 会拿到假
// transport（组跑挂、单跑过的指纹）。探针进程注册表干净，退出码即断言。
test("stdio transport sends and receives JSON-RPC messages", async () => {
  const probe = path.join(import.meta.dir, "fixture", "stdio-probe.ts")
  const child = Bun.spawn([process.execPath, "run", probe], {
    cwd: path.join(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) console.error(stderr)
  expect(code).toBe(0)
}, 20_000)
