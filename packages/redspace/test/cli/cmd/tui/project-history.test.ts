import { describe, expect, test } from "bun:test"
import { Global } from "@redcode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import {
  forgetProjectVisit,
  readProjectHistory,
  recordProjectVisit,
} from "../../../../src/cli/cmd/tui/project-history"

async function withState<T>(run: (path: string) => Promise<T>) {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  try {
    return await run(tmp.path)
  } finally {
    Global.Path.state = previous
  }
}

describe("tui project history", () => {
  // 261110 Red 启动与回首页的记录不带 sessionID，不能把「最后查看会话」抹掉。
  test("revisiting without a session keeps the last viewed session", async () => {
    await withState(async (directory) => {
      await recordProjectVisit({ directory, sessionID: "ses_last" })
      await recordProjectVisit({ directory })
      expect((await readProjectHistory())[0]?.sessionID).toBe("ses_last")
    })
  })

  test("switching to another session replaces the stored id", async () => {
    await withState(async (directory) => {
      await recordProjectVisit({ directory, sessionID: "ses_first" })
      await recordProjectVisit({ directory, sessionID: "ses_second" })
      const visits = await readProjectHistory()
      expect(visits).toHaveLength(1)
      expect(visits[0]?.sessionID).toBe("ses_second")
    })
  })

  // 261110 Red 删除后重新访问是一条全新记录，不能继承已被 forget 的会话。
  test("a forgotten project does not inherit the old session", async () => {
    await withState(async (directory) => {
      await recordProjectVisit({ directory, sessionID: "ses_gone" })
      await forgetProjectVisit(directory)
      await recordProjectVisit({ directory })
      expect((await readProjectHistory())[0]?.sessionID).toBeUndefined()
    })
  })
})
