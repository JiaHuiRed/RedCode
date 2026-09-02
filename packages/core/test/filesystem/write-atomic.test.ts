import { describe, test, expect } from "bun:test"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { mkdtemp, readFile, readdir, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

const scratch = () => mkdtemp(path.join(tmpdir(), "redcode-atomic-"))

/** 造一个带 code 的错误，形状与 Node 的 fs 错误一致。 */
function errno(code: string) {
  return Object.assign(new Error(code), { code })
}

/** 前 n 次以 code 失败、之后成功的 rename；同时记录被调用了几次。 */
function flakyRename(failures: number, code: string) {
  const calls: [string, string][] = []
  const rename = async (from: string, to: string) => {
    calls.push([from, to])
    if (calls.length <= failures) throw errno(code)
  }
  return { rename, calls }
}

describe("AppFileSystem.writeFileAtomic", () => {
  test("写入新文件，并按需创建父目录", async () => {
    const dir = await scratch()
    const file = path.join(dir, "nested", "deeper", "config.json")
    await AppFileSystem.writeFileAtomic(file, '{"a":1}')
    expect(await readFile(file, "utf8")).toBe('{"a":1}')
  })

  test("替换已有文件，且不留下临时兄弟文件", async () => {
    const dir = await scratch()
    const file = path.join(dir, "config.json")
    await writeFile(file, "old")
    await AppFileSystem.writeFileAtomic(file, "new")
    expect(await readFile(file, "utf8")).toBe("new")
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([])
  })

  // 上游 note：2026-08-29-windows-atomic-replace-retry。别的系统组件（杀软 / 索引器 /
  // 另一个读者）临时握着目标句柄时，替换会以这三个码被拒，而这是瞬时的。
  for (const code of ["EACCES", "EBUSY", "EPERM"]) {
    test(`Windows 上重试 ${code} 并最终成功`, async () => {
      const { rename, calls } = flakyRename(3, code)
      const slept: number[] = []
      await AppFileSystem.renameWithRetry("from", "to", {
        rename,
        platform: "win32",
        sleep: async (ms) => void slept.push(ms),
      })
      expect(calls.length).toBe(4)
      expect(slept).toEqual([20, 40, 80])
    })
  }

  test("非可重试码立刻失败，只尝试一次", async () => {
    const { rename, calls } = flakyRename(1, "ENOSPC")
    const slept: number[] = []
    await expect(
      AppFileSystem.renameWithRetry("from", "to", {
        rename,
        platform: "win32",
        sleep: async (ms) => void slept.push(ms),
      }),
    ).rejects.toThrow("ENOSPC")
    expect(calls.length).toBe(1)
    expect(slept).toEqual([])
  })

  test("非 Windows 平台不重试", async () => {
    const { rename, calls } = flakyRename(1, "EBUSY")
    await expect(
      AppFileSystem.renameWithRetry("from", "to", { rename, platform: "linux", sleep: async () => {} }),
    ).rejects.toThrow("EBUSY")
    expect(calls.length).toBe(1)
  })

  test("重试预算用尽：9 次尝试、累计 1.1 秒，然后抛出", async () => {
    const { rename, calls } = flakyRename(Number.MAX_SAFE_INTEGER, "EBUSY")
    const slept: number[] = []
    await expect(
      AppFileSystem.renameWithRetry("from", "to", {
        rename,
        platform: "win32",
        sleep: async (ms) => void slept.push(ms),
      }),
    ).rejects.toThrow("EBUSY")
    expect(calls.length).toBe(9)
    expect(slept).toEqual([20, 40, 80, 160, 200, 200, 200, 200])
    expect(slept.reduce((a, b) => a + b, 0)).toBe(1100)
  })

  // 这条是整个改动的意义所在：替换失败时目标文件**全程没被碰过**，
  // 读者看到的始终是完整的旧内容，而不是半截 JSON。
  test("替换失败时目标保持旧内容，临时文件被清掉", async () => {
    const dir = await scratch()
    const file = path.join(dir, "config.json")
    await writeFile(file, "old")
    await expect(
      AppFileSystem.writeFileAtomic(file, "new", undefined, {
        rename: async () => {
          throw errno("EBUSY")
        },
        platform: "win32",
        sleep: async () => {},
      }),
    ).rejects.toThrow("EBUSY")
    expect(await readFile(file, "utf8")).toBe("old")
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([])
  })

  test("同一毫秒内连写不撞临时文件名", async () => {
    const dir = await scratch()
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => AppFileSystem.writeFileAtomic(path.join(dir, `f${i}.json`), String(i))),
    )
    const names = await readdir(dir)
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([])
    expect(names.length).toBe(8)
  })
})
