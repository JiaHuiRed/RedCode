import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { sweepStaleTestDirs, PREFIX } from "./sweep-temp"

// 清扫自己也要有闸门 —— 它删的是别人的目录，判据写宽一点点就会误删。
async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sweep-spec-"))
  const age = (hours: number) => Date.now() - hours * 60 * 60 * 1000
  const make = async (name: string, hours: number, file?: string) => {
    const dir = path.join(root, name)
    await fs.mkdir(dir, { recursive: true })
    if (file) await fs.writeFile(path.join(dir, "payload.bin"), file)
    await fs.utimes(dir, new Date(age(hours)), new Date(age(hours)))
    return dir
  }
  return { root, make, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

const names = (root: string) => fs.readdir(root).then((list) => list.sort())

describe("sweepStaleTestDirs", () => {
  test("removes stale dirs and leaves fresh ones", async () => {
    const box = await sandbox()
    try {
      await box.make(`${PREFIX}-old`, 5)
      await box.make(`${PREFIX}-data-1234`, 26)
      await box.make(`${PREFIX}-fresh`, 0.1)

      const result = await sweepStaleTestDirs({ root: box.root, ttlHours: 2 })

      expect(result.removed).toBe(2)
      expect(result.skipped).toBe(0)
      expect(await names(box.root)).toEqual([`${PREFIX}-fresh`])
    } finally {
      await box.cleanup()
    }
  })

  // 并发跑的另一个测试进程，它的目录一定是新的 —— 这就是不按 pid 判活的理由。
  test("never touches a dir younger than the ttl", async () => {
    const box = await sandbox()
    try {
      await box.make(`${PREFIX}-concurrent`, 1.9)
      const result = await sweepStaleTestDirs({ root: box.root, ttlHours: 2 })
      expect(result.removed).toBe(0)
      expect(await names(box.root)).toEqual([`${PREFIX}-concurrent`])
    } finally {
      await box.cleanup()
    }
  })

  test("only matches the redcode-test prefix", async () => {
    const box = await sandbox()
    try {
      await box.make("redcode-test-yes", 5)
      await box.make("some-other-tool", 5)
      await box.make("redcode-live-session", 5)

      await sweepStaleTestDirs({ root: box.root, ttlHours: 2 })
      expect(await names(box.root)).toEqual(["redcode-live-session", "some-other-tool"])
    } finally {
      await box.cleanup()
    }
  })

  test("reports the bytes it reclaimed", async () => {
    const box = await sandbox()
    try {
      await box.make(`${PREFIX}-heavy`, 5, "x".repeat(4096))
      const result = await sweepStaleTestDirs({ root: box.root, ttlHours: 2 })
      expect(result.removed).toBe(1)
      expect(result.bytes).toBe(4096)
    } finally {
      await box.cleanup()
    }
  })

  test("ttlHours <= 0 disables the sweep entirely", async () => {
    const box = await sandbox()
    try {
      await box.make(`${PREFIX}-ancient`, 1000)
      const result = await sweepStaleTestDirs({ root: box.root, ttlHours: 0 })
      expect(result).toEqual({ removed: 0, bytes: 0, skipped: 0 })
      expect(await names(box.root)).toEqual([`${PREFIX}-ancient`])
    } finally {
      await box.cleanup()
    }
  })

  // 清扫失败不该让测试跑不起来。
  test("a missing root is not an error", async () => {
    const result = await sweepStaleTestDirs({ root: path.join(os.tmpdir(), "sweep-spec-does-not-exist"), ttlHours: 2 })
    expect(result.removed).toBe(0)
  })

  test("ignores files that merely share the prefix", async () => {
    const box = await sandbox()
    try {
      const file = path.join(box.root, `${PREFIX}-not-a-dir`)
      await fs.writeFile(file, "x")
      await fs.utimes(file, new Date(Date.now() - 5 * 3600_000), new Date(Date.now() - 5 * 3600_000))

      const result = await sweepStaleTestDirs({ root: box.root, ttlHours: 2 })
      expect(result.removed).toBe(0)
      expect(await names(box.root)).toEqual([`${PREFIX}-not-a-dir`])
    } finally {
      await box.cleanup()
    }
  })
})
