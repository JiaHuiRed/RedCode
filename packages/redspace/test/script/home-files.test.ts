import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeAtomic } from "../../../../script/home-files"

const dirs: string[] = []

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "redcode-home-files-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("writeAtomic", () => {
  test("creates missing directories and leaves no temporary file behind", async () => {
    const dir = await tempDir()
    const file = join(dir, "nested", "redcode.jsonc")

    await writeAtomic(file, '{"a":1}')

    expect(await readFile(file, "utf-8")).toBe('{"a":1}')
    expect(await readdir(join(dir, "nested"))).toEqual(["redcode.jsonc"])
  })

  test("replaces existing content without trailing temporaries", async () => {
    const dir = await tempDir()
    const file = join(dir, "config.jsonc")
    await writeFile(file, "old")

    await writeAtomic(file, "new")

    expect(await readFile(file, "utf-8")).toBe("new")
    expect(await readdir(dir)).toEqual(["config.jsonc"])
  })

  test("keeps the original file when the write fails", async () => {
    const dir = await tempDir()
    const file = join(dir, "config.jsonc")
    await writeFile(file, "original")

    // 用一个已存在的同内容临时文件不可预测，改为传非法内容类型触发写入失败。
    await expect(writeAtomic(file, undefined as unknown as string)).rejects.toThrow()
    expect(await readFile(file, "utf-8")).toBe("original")
    expect(await readdir(dir)).toEqual(["config.jsonc"])
  })
})
