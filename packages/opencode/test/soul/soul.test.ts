import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { Soul } from "@/soul"

const it = testEffect(Layer.mergeAll(Soul.defaultLayer))

const write = (file: string, content: string) => Effect.promise(() => Bun.write(file, content))

const official = (body: string) => `---\n${body}\n---\n\n# 标题\n\n正文内容\n`

describe("soul registry", () => {
  it.instance("lists official souls sorted by filename, parsing metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(
        path.join(dir, "yuqi.md"),
        official("id: yuqi\nname: 宋雨琦\ndisplay_name: 雨琦\ncommit_prefix: YuQi\navatar: yuqi"),
      )
      yield* write(
        path.join(dir, "karina.md"),
        official("id: karina\nname: 柳智敏\ndisplay_name: 敏敏\ncommit_prefix: Karina"),
      )

      const list = yield* (yield* Soul.Service).list().pipe(Effect.provideService(Soul.directory, dir))
      expect(list.map((soul) => soul.id)).toEqual(["karina", "yuqi"])
      expect(list[0]).toEqual({
        id: "karina",
        name: "柳智敏",
        displayName: "敏敏",
        commitPrefix: "Karina",
        avatar: undefined,
      })
      expect(list[1].avatar).toBe("yuqi")
    }),
  )

  it.instance("falls back to name when optional fields are missing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "chi.md"), official("id: chi\nname: 赤"))

      const list = yield* (yield* Soul.Service).list().pipe(Effect.provideService(Soul.directory, dir))
      expect(list).toEqual([{ id: "chi", name: "赤", displayName: "赤", commitPrefix: "赤", avatar: undefined }])
    }),
  )

  it.instance("legacy file without frontmatter uses filename id and heading name", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "# 柳智敏 · RedCode TUI soul\n\n正文内容\n")

      const list = yield* (yield* Soul.Service).list().pipe(Effect.provideService(Soul.directory, dir))
      expect(list).toEqual([{ id: "tsoul", name: "柳智敏", displayName: "柳智敏", commitPrefix: "柳智敏" }])
    }),
  )

  it.instance("reports invalid id as an issue without listing the soul", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "bad.md"), official('id: "Bad ID"\nname: 坏'))

      const soul = yield* Soul.Service
      const list = yield* soul.list().pipe(Effect.provideService(Soul.directory, dir))
      const issues = yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))
      expect(list).toEqual([])
      expect(issues.length).toBe(1)
      expect(issues[0].message).toContain("invalid id")
    }),
  )

  it.instance("reports duplicate id keeping the first file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "a.md"), official("id: karina\nname: 柳智敏"))
      yield* write(path.join(dir, "b.md"), official("id: karina\nname: 重复"))

      const soul = yield* Soul.Service
      const list = yield* soul.list().pipe(Effect.provideService(Soul.directory, dir))
      const issues = yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))
      expect(list.map((item) => item.name)).toEqual(["柳智敏"])
      expect(issues.length).toBe(1)
      expect(issues[0].message).toContain("duplicate")
    }),
  )

  it.instance("reports oversize and empty-content files as issues", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "big.md"), official("id: big\nname: 大") + "x".repeat(17 * 1024))
      yield* write(path.join(dir, "empty.md"), "---\nid: empty\nname: 空\n---\n\n   \n")

      const soul = yield* Soul.Service
      const list = yield* soul.list().pipe(Effect.provideService(Soul.directory, dir))
      const issues = yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))
      expect(list).toEqual([])
      expect(issues.map((issue) => issue.message).sort()).toEqual(["empty content", "exceeds 16384 bytes"])
    }),
  )

  it.instance("get returns content without frontmatter; unknown id returns undefined", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "karina.md"), official("id: karina\nname: 柳智敏"))

      const soul = yield* Soul.Service
      const found = yield* soul.get("karina").pipe(Effect.provideService(Soul.directory, dir))
      expect(found?.path).toContain("karina.md")
      expect(found?.content.startsWith("# 标题")).toBe(true)
      expect(found?.content.includes("---")).toBe(false)

      const missing = yield* soul.get("nope").pipe(Effect.provideService(Soul.directory, dir))
      expect(missing).toBeUndefined()
    }),
  )

  it.effect("defaultForClient maps tui to karina and desktop to yuqi", () =>
    Effect.gen(function* () {
      const soul = yield* Soul.Service
      expect(yield* soul.defaultForClient("tui")).toBe("karina")
      expect(yield* soul.defaultForClient("desktop")).toBe("yuqi")
    }),
  )
})
