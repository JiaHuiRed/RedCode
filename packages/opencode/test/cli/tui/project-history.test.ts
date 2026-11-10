import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@redcode-ai/core/global"
import { tmpdir } from "../../fixture/fixture"
import {
  readProjectHistory,
  readIgnoredProjects,
  recordProjectVisit,
  forgetProjectVisit,
} from "../../../src/cli/cmd/tui/project-history"

// 261110 Red history 文件路径在调用时从 Global.Path.state 求值，测试用临时 state 目录隔离。
async function withState<T>(fn: () => Promise<T>): Promise<T> {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  try {
    return await fn()
  } finally {
    Global.Path.state = previous
  }
}

describe("project history", () => {
  test("returns an empty list when no history file exists", () =>
    withState(async () => {
      expect(await readProjectHistory()).toEqual([])
    }))

  test("records visits newest first and stores only project metadata", () =>
    withState(async () => {
      const first = path.join(Global.Path.state, "first")
      const second = path.join(Global.Path.state, "second")
      await recordProjectVisit({ directory: first, name: "First", sessionID: "ses_first" })
      await recordProjectVisit({ directory: second })

      const list = await readProjectHistory()
      expect(list.map((item) => item.directory)).toEqual([second, first])
      expect(typeof list[0]!.usedAt).toBe("number")
      expect(list[1]).toMatchObject({ directory: first, name: "First", sessionID: "ses_first" })
      expect(Object.keys(list[1]!).sort()).toEqual(["directory", "name", "sessionID", "usedAt"])
    }))

  test("deduplicates the same directory and keeps the latest visit metadata", () =>
    withState(async () => {
      const directory = path.join(Global.Path.state, "same")
      await recordProjectVisit({ directory, sessionID: "ses_old" })
      await recordProjectVisit({ directory: directory + path.sep + ".", sessionID: "ses_new" })

      const list = await readProjectHistory()
      expect(list).toHaveLength(1)
      expect(list[0]!.sessionID).toBe("ses_new")
    }))

  test("drops invalid entries and unknown fields at the file boundary", () =>
    withState(async () => {
      const valid = path.join(Global.Path.state, "valid")
      await fs.writeFile(
        path.join(Global.Path.state, "projects.json"),
        JSON.stringify([
          null,
          "nope",
          { directory: 1, usedAt: 1 },
          { directory: "", usedAt: 1 },
          { directory: valid, usedAt: "soon" },
          { directory: valid, usedAt: 3, name: "Valid", draft: { text: "leak" } },
        ]),
      )

      const list = await readProjectHistory()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ directory: valid, usedAt: 3, name: "Valid" })
      expect(Object.keys(list[0]!).sort()).toEqual(["directory", "name", "usedAt"])
    }))

  test("treats malformed and non-array files as empty", () =>
    withState(async () => {
      const file = path.join(Global.Path.state, "projects.json")
      await fs.writeFile(file, "{ not json")
      expect(await readProjectHistory()).toEqual([])

      await fs.writeFile(file, JSON.stringify({ directory: "x", usedAt: 1 }))
      expect(await readProjectHistory()).toEqual([])
    }))

  test("does not truncate a long history", () =>
    withState(async () => {
      const entries = Array.from({ length: 30 }, (_, index) => ({
        directory: path.join(Global.Path.state, `project-${index}`),
        usedAt: index + 1,
      }))
      await fs.writeFile(path.join(Global.Path.state, "projects.json"), JSON.stringify(entries))

      const list = await readProjectHistory()
      expect(list).toHaveLength(entries.length)
      expect(list[0]!.directory).toBe(entries.at(-1)!.directory)
    }))

  test("forgetting a workspace only hides that record and keeps the rest", () =>
    withState(async () => {
      const keep = path.join(Global.Path.state, "keep")
      const drop = path.join(Global.Path.state, "drop")
      await recordProjectVisit({ directory: keep })
      await recordProjectVisit({ directory: drop })

      expect(await forgetProjectVisit(drop)).toBe(true)
      expect((await readProjectHistory()).map((item) => item.directory)).toEqual([keep])
      expect((await readIgnoredProjects()).map((item) => path.resolve(item))).toEqual([path.resolve(drop)])
      // 再删一次：已经不在记录里也不再重复写入
      expect(await forgetProjectVisit(drop)).toBe(false)
      expect(await readIgnoredProjects()).toHaveLength(1)
    }))

  test("recording a forgotten workspace brings it back", () =>
    withState(async () => {
      const directory = path.join(Global.Path.state, "returning")
      await recordProjectVisit({ directory })
      await forgetProjectVisit(directory)
      expect(await readIgnoredProjects()).toHaveLength(1)

      await recordProjectVisit({ directory })
      expect((await readProjectHistory()).map((item) => item.directory)).toEqual([directory])
      expect(await readIgnoredProjects()).toEqual([])
    }))
})
