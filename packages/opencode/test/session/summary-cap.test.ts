import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Storage } from "@/storage/storage"
import { SessionSummary } from "@/session/summary"
import { Session as SessionNs } from "@/session/session"
import type { Snapshot } from "@/snapshot"
import { SessionID } from "@/session/schema"
import * as Log from "@redcode-ai/core/util/log"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

// 260904 cc A1 第 3 步：一份 diffs 里 patch 正文的总字节上限。存量不动、只对新写入生效；
// 超限时不丢文件条目，只把最大的几个 patch 清成 ""。

const file = (name: string, patch: string, adds = 1): Snapshot.FileDiff => ({
  file: name,
  patch,
  additions: adds,
  deletions: 0,
  status: "modified",
})

describe("SessionSummary.capPatches", () => {
  test("under the limit returns the same array untouched", () => {
    const input = [file("a", "x".repeat(10)), file("b", "y".repeat(20))]
    expect(SessionSummary.capPatches(input, 30)).toBe(input)
  })

  test("blanks the largest patches first until under the limit; entries and counts survive", () => {
    const input = [file("small", "s".repeat(10), 1), file("big", "b".repeat(100), 50), file("mid", "m".repeat(40), 7)]
    const out = SessionSummary.capPatches(input, 60)
    expect(out.map((x) => x.file)).toEqual(["small", "big", "mid"])
    expect(out.map((x) => x.patch)).toEqual(["s".repeat(10), "", "m".repeat(40)])
    expect(out.map((x) => x.additions)).toEqual([1, 50, 7])
  })

  test("keeps blanking when one file is not enough", () => {
    const input = [file("a", "a".repeat(50)), file("b", "b".repeat(50)), file("c", "c".repeat(5))]
    const out = SessionSummary.capPatches(input, 40)
    expect(out.map((x) => x.patch)).toEqual(["", "", "c".repeat(5)])
  })

  test("counts bytes, not code units", () => {
    // 3 个汉字 = 9 字节：8 字节的预算装不下
    const input = [file("a", "汉字文")]
    expect(SessionSummary.capPatches(input, 8)[0]!.patch).toBe("")
    expect(SessionSummary.capPatches(input, 9)[0]!.patch).toBe("汉字文")
  })
})

// 260904 cc A1 第 4 步：diff 端点 patch=false 只回元数据。TUI 进会话用它填 Files 侧栏，
// 病态会话那份 33MB 的正文一个字节不传。
const it = testEffect(Layer.mergeAll(SessionSummary.defaultLayer, Storage.defaultLayer))

describe("SessionSummary.diff patch=false", () => {
  it.effect("strips patch bodies but keeps file metadata", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const summary = yield* SessionSummary.Service
      const sessionID = SessionID.descending()
      yield* storage.write(["session_diff", sessionID], [file("a.ts", "+a\n", 3), file("b.ts", "+b\n", 1)])
      const full = yield* summary.diff({ sessionID })
      expect(full.map((x) => x.patch)).toEqual(["+a\n", "+b\n"])
      const meta = yield* summary.diff({ sessionID, patch: false })
      expect(meta).toEqual([
        { file: "a.ts", additions: 3, deletions: 0, status: "modified" },
        { file: "b.ts", additions: 1, deletions: 0, status: "modified" },
      ])
      expect(meta.some((x) => "patch" in x)).toBe(false)
      yield* storage.remove(["session_diff", sessionID])
    }),
  )
})

// 260904 cc A1 第 5 步：删会话时 storage 里那份 session_diff/<id>.json 跟着删（此前从不清理，留孤儿）。
const withDb = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Storage.defaultLayer))

describe("Session.remove", () => {
  withDb.instance("removes the session_diff storage file with the session", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      yield* storage.write(["session_diff", created.id], [file("a.ts", "+a\n")])
      expect(yield* storage.read<Snapshot.FileDiff[]>(["session_diff", created.id])).toHaveLength(1)
      yield* session.remove(created.id)
      const after = yield* storage.read<Snapshot.FileDiff[]>(["session_diff", created.id]).pipe(Effect.flip)
      expect(after._tag).toBe("NotFoundError")
    }),
  )
})
