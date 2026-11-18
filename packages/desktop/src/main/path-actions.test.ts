import { describe, expect, test } from "bun:test"
import { openPathChecked } from "./path-actions"

describe("openPathChecked", () => {
  test("passes the path to the OS and resolves only after a successful open", async () => {
    const paths: string[] = []
    await expect(
      openPathChecked("/example/SOUL.md", async (path) => {
        paths.push(path)
        return ""
      }),
    ).resolves.toBeUndefined()
    expect(paths).toEqual(["/example/SOUL.md"])
  })

  test("turns the OS failure string into a rejected request", async () => {
    await expect(openPathChecked("/missing", async () => "The file does not exist")).rejects.toThrow(
      "The file does not exist",
    )
  })
})
