// 261103 Red smoke lane：核心 provider/session/httpapi 文件各自起独立 Bun 进程。
// 同进程并行会互相污染（prompt 单独 115 全过，四文件同进程会挂 native preflight）。
import { mkdir, rm } from "node:fs/promises"

const files = [
  "test/provider/error.test.ts",
  "test/session/retry.test.ts",
  "test/session/message-v2.test.ts",
  "test/session/prompt.test.ts",
  "test/session/processor-effect.test.ts",
  "test/session/llm.test.ts",
  "test/server/httpapi-sdk.test.ts",
]
const out = ".artifacts/smoke"

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

for (const file of files) {
  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.test\.ts$/, "")
  const child = Bun.spawn(
    ["bun", "test", "--timeout", "30000", "--reporter=junit", "--reporter-outfile", `${out}/${name}.xml`, file],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  )
  const code = await child.exited
  if (code !== 0) process.exit(code)
}
