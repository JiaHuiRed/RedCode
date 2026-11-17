import { describe, expect, test } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  checkToolDescriptionBudget,
  MAX_TOOL_DESCRIPTION_BYTES,
} from "../../../../script/check-tool-description-budget"
import { tmpdir } from "../fixture/fixture"

describe("tool description source budget", () => {
  test("uses the approved 32 KiB limit", () => {
    expect(MAX_TOOL_DESCRIPTION_BYTES).toBe(32_768)
  })

  test("counts UTF-8 bytes recursively and ignores non-markdown files", async () => {
    await using tmp = await tmpdir()
    await mkdir(join(tmp.path, "shell"))
    await Bun.write(join(tmp.path, "read.md"), "\u96e8\u7426")
    await Bun.write(join(tmp.path, "shell", "shell.md"), "shell\n")
    await Bun.write(join(tmp.path, "ignored.ts"), "x".repeat(MAX_TOOL_DESCRIPTION_BYTES))

    expect(checkToolDescriptionBudget(tmp.path)).toEqual({
      files: 2,
      bytes: 12,
      remaining: MAX_TOOL_DESCRIPTION_BYTES - 12,
    })
  })

  test("accepts one byte below the limit", async () => {
    await using tmp = await tmpdir()
    await Bun.write(join(tmp.path, "read.md"), "x".repeat(MAX_TOOL_DESCRIPTION_BYTES - 1))
    expect(checkToolDescriptionBudget(tmp.path).remaining).toBe(1)
  })

  test("accepts exactly the limit without rewriting the description", async () => {
    await using tmp = await tmpdir()
    const file = join(tmp.path, "read.md")
    const content = "x".repeat(MAX_TOOL_DESCRIPTION_BYTES)
    await Bun.write(file, content)

    expect(checkToolDescriptionBudget(tmp.path).remaining).toBe(0)
    expect(await readFile(file, "utf-8")).toBe(content)
  })

  test("rejects an aggregate excess of one byte without truncating either file", async () => {
    await using tmp = await tmpdir()
    const file = join(tmp.path, "read.md")
    const content = "x".repeat(MAX_TOOL_DESCRIPTION_BYTES)
    await Bun.write(file, content)
    await Bun.write(join(tmp.path, "write.md"), "y")

    expect(() => checkToolDescriptionBudget(tmp.path)).toThrow("32769/32768 bytes (over by 1)")
    expect(await readFile(file, "utf-8")).toBe(content)
    expect(await readFile(join(tmp.path, "write.md"), "utf-8")).toBe("y")
  })

  test("fails rather than treating an empty scan as a passing check", async () => {
    await using tmp = await tmpdir()
    await Bun.write(join(tmp.path, "ignored.ts"), "ignored")
    expect(() => checkToolDescriptionBudget(tmp.path)).toThrow("no descriptions found")
  })

  test("an uncaught budget violation exits the checking process unsuccessfully", async () => {
    await using tmp = await tmpdir()
    await Bun.write(join(tmp.path, "read.md"), "x".repeat(MAX_TOOL_DESCRIPTION_BYTES + 1))
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { checkToolDescriptionBudget } from ${JSON.stringify(
          join(import.meta.dir, "../../../../script/check-tool-description-budget.ts"),
        )}; checkToolDescriptionBudget(process.argv[1])`,
        tmp.path,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 5_000 },
    )
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code).toBe(1)
    expect(error).toContain("over by 1")
  })
})
