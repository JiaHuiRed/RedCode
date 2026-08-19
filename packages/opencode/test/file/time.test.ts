import { afterAll, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { FileTime } from "../../src/file/time"

// 260819 cc audit：state 此前零删除，会话维度只增不减（CLI 无影响，长驻的 GUI sidecar /
// serve 进程按会话数持续堆积）。这里钉住数量上限那一支；TTL 那一支与 prompt-caches 的
// touchSession 是同一份逻辑，时间可注入的完整用例在 test/session/prompt-caches.test.ts。

const dir = path.join(os.tmpdir(), "redcode-filetime-test")
const file = path.join(dir, "target.txt")

beforeEach(async () => {
  FileTime.reset()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, "hello")
})

afterAll(async () => {
  FileTime.reset()
  await fs.rm(dir, { recursive: true, force: true })
})

test("会话数超过上限时最冷的被挤掉，总量有界", async () => {
  for (let i = 0; i < 40; i++) await Effect.runPromise(FileTime.record(`ses_${i}`, file))
  expect(FileTime.sessionCount()).toBe(32)
  // 最早的被挤掉：assert 落到"没读过"分支
  await expect(Effect.runPromise(FileTime.assert("ses_0", file))).rejects.toThrow(
    /must read file/i,
  )
  // 最近的仍在，assert 正常通过
  await Effect.runPromise(FileTime.assert("ses_39", file))
})

test("持续活跃的会话不会被别人挤掉", async () => {
  await Effect.runPromise(FileTime.record("ses_hot", file))
  for (let i = 0; i < 40; i++) {
    await Effect.runPromise(FileTime.record(`ses_${i}`, file))
    await Effect.runPromise(FileTime.assert("ses_hot", file)) // assert 也算触碰
  }
  expect(FileTime.sessionCount()).toBeLessThanOrEqual(32)
  await Effect.runPromise(FileTime.assert("ses_hot", file))
})

// 回收不能把守卫本身改松：没读过仍要拦，读过之后被外部改动仍要拦。
test("守卫语义不受回收影响", async () => {
  await expect(Effect.runPromise(FileTime.assert("ses_unread", file))).rejects.toThrow(
    /must read file/i,
  )
  await Effect.runPromise(FileTime.record("ses_read", file))
  await Effect.runPromise(FileTime.assert("ses_read", file))
  await new Promise((r) => setTimeout(r, 10))
  await fs.writeFile(file, "changed externally")
  await expect(Effect.runPromise(FileTime.assert("ses_read", file))).rejects.toThrow(
    /modified externally/i,
  )
})
