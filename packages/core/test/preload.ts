// 260811 cc audit Y8 续：core 包此前没有 preload，`bun test` 在这里跑时
// REDCODE_TEST_HOME 未设 → Global 的所有路径解析到开发者真实的 ~/.redcode。
// models.test.ts 正是这么把真实的 cache/models.json 删掉又重写的（3.6MB 的模型目录，
// 删了要重新联网拉）。opencode 包早有同名 preload，core 只是一直没跟上。
import os from "os"
import path from "path"
import fs from "fs/promises"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "redcode-core-test-" + process.pid)
const home = path.join(dir, "home")
await fs.mkdir(home, { recursive: true })
process.env["REDCODE_TEST_HOME"] = home

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})
