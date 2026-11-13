import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import fs from "node:fs"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { Soul } from "@/soul"
import { MAX_SOUL_BYTES } from "@/soul/schema"
import { migrateLegacySouls } from "@/soul/migration"

const it = testEffect(Layer.mergeAll(Soul.defaultLayer))

const write = (file: string, content: string) => Effect.promise(() => Bun.write(file, content))

const official = (body: string) => `---\n${body}\n---\n\n# 标题\n\n正文内容\n`

// frontmatter 里若执行了代码，哨兵会被写到 globalThis；只读不改。
const readProbe = (key: string) => (globalThis as unknown as Record<string, unknown>)[key]

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

  it.instance("trims and exposes optional descriptions in summaries and info", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "chi.md"), official("id: chi\nname: 赤\ndescription: '  擅长简洁分析  '"))
      yield* write(
        path.join(dir, "max.md"),
        official(`id: max\nname: Max\ndescription: '${"a".repeat(256)}'`),
      )
      yield* write(path.join(dir, "legacy.md"), official("id: legacy\nname: 旧助手"))

      const soul = yield* Soul.Service
      const list = yield* soul.list().pipe(Effect.provideService(Soul.directory, dir))
      expect(list.find((item) => item.id === "chi")?.description).toBe("擅长简洁分析")
      expect(list.find((item) => item.id === "max")?.description).toBe("a".repeat(256))
      expect(list.find((item) => item.id === "legacy")?.description).toBeUndefined()
      expect((yield* soul.get("chi").pipe(Effect.provideService(Soul.directory, dir)))?.description).toBe(
        "擅长简洁分析",
      )
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

  it.instance("uses displayName for attribution before name when commit_prefix is absent", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "helper.md"), official("id: helper\nname: Full Name\ndisplay_name: Short Name"))
      const info = yield* (yield* Soul.Service).get("helper").pipe(Effect.provideService(Soul.directory, dir))
      expect(info?.commitPrefix).toBe("Short Name")
    }),
  )

  // 261113 Red gray-matter 按首行 `---lang` 选引擎，内置 javascript 引擎走 eval：
  // 非 YAML 语言标记必须在解析前被拒绝，而不是在字段校验阶段才失败（那时已经执行了）。
  it.instance("refuses executable frontmatter languages without executing them", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const probe = "__red_soul_frontmatter_probe"
      const payload = `globalThis["${probe}"] = "executed"`
      yield* write(path.join(dir, "evil.md"), `---js\n${payload}\n---\n\n# x\nbody\n`)
      // BOM 绕不过：gray-matter 入口先剥 BOM 再按语言选引擎，检测必须对齐
      yield* write(path.join(dir, "evil-bom.md"), `\uFEFF---js\n${payload}\n---\n\n# x\nbody\n`)
      const soul = yield* Soul.Service

      const list = yield* soul.list().pipe(Effect.provideService(Soul.directory, dir))
      expect(list.map((item) => item.id)).toEqual([])
      expect(readProbe(probe)).toBeUndefined()
      const issues = yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))
      expect(issues.filter((issue) => issue.message.includes("unsupported frontmatter language"))).toHaveLength(2)
    }),
  )

  it.instance("migrates official and customized legacy files without changing old bodies", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const karinaBody = "# 柳智敏 · RedCode\n\nuser body\n"
      const customBody = "# My Assistant\n\ncustom body\n"
      yield* write(path.join(dir, "Tsoul.md"), karinaBody)
      yield* write(path.join(dir, "Gsoul.md"), customBody)
      const result = yield* Effect.sync(() => migrateLegacySouls(dir))
      expect(result.defaults).toEqual({ tui: "karina", desktop: "legacy-desktop" })
      expect(result.issues).toEqual([])
      expect(fs.readFileSync(path.join(dir, "karina.md"), "utf8")).toContain(karinaBody)
      expect(fs.readFileSync(path.join(dir, "legacy-desktop.md"), "utf8")).toContain(customBody)
      expect(fs.readFileSync(path.join(dir, "karina.md"), "utf8")).toContain('commit_prefix: "Karina"')
      expect(fs.readFileSync(path.join(dir, "karina.md"), "utf8")).toContain('display_name: "敏敏"')
      expect(migrateLegacySouls(dir).defaults).toEqual(result.defaults)
      expect(
        yield* (yield* Soul.Service).defaultForClient("desktop").pipe(Effect.provideService(Soul.directory, dir)),
      ).toBe("legacy-desktop")
    }),
  )

  it.instance("migrates trimmed descriptions, preserves the legacy source, and remains idempotent", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const raw =
        "---\nid: custom-karina\nname: 自定义助手\ndescription: '  擅长简洁分析  '\n---\n\n# 自定义助手\n\nbody preserved exactly\n"
      yield* write(path.join(dir, "Tsoul.md"), raw)

      const migrated = migrateLegacySouls(dir)
      const destination = path.join(dir, "custom-karina.md")
      const created = fs.readFileSync(destination, "utf8")
      expect(migrated.defaults.tui).toBe("custom-karina")
      expect(migrated.issues).toEqual([])
      expect(created).toContain('description: "擅长简洁分析"')
      expect(created).toContain("\n\n# 自定义助手\n\nbody preserved exactly\n")
      expect(fs.readFileSync(path.join(dir, "Tsoul.md"), "utf8")).toBe(raw)
      expect(migrateLegacySouls(dir).issues).toEqual([])
      expect(fs.readFileSync(destination, "utf8")).toBe(created)
      expect(fs.readFileSync(path.join(dir, "Tsoul.md"), "utf8")).toBe(raw)
    }),
  )

  it.instance("does not accept a destination copy with a different description", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const body = "\n\n# Assistant\n\nsame body\n"
      yield* write(
        path.join(dir, "Tsoul.md"),
        `---\nid: helper\nname: Assistant\ndescription: Source description\n---${body}`,
      )
      yield* write(
        path.join(dir, "helper.md"),
        `---\nid: helper\nname: Assistant\ndescription: Other description\n---${body}`,
      )

      const result = migrateLegacySouls(dir)
      expect(result.issues.join(" ")).toContain("was not migrated")
      expect(fs.readFileSync(path.join(dir, "Tsoul.md"), "utf8")).toContain("description: Source description")
      expect(fs.readFileSync(path.join(dir, "helper.md"), "utf8")).toContain("description: Other description")
      expect(JSON.parse(fs.readFileSync(path.join(dir, ".legacy-defaults.json"), "utf8")).copies?.tui).toBeUndefined()
    }),
  )

  it.instance("refuses invalid legacy descriptions and preserves each source with an issue", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      for (const [caseName, description] of [
        ["type", "42"],
        ["multiline", '"first line\\nsecond line"'],
        ["oversized", `'${"你".repeat(86)}'`],
      ] as [string, string][]) {
        const dir = path.join(test.directory, caseName)
        fs.mkdirSync(dir)
        const raw = `---\nid: helper\nname: Assistant\ndescription: ${description}\n---\n\n# Assistant\n\nbody\n`
        fs.writeFileSync(path.join(dir, "Tsoul.md"), raw)

        const result = migrateLegacySouls(dir)
        expect(result.issues.join(" ")).toContain("Tsoul.md has malformed metadata")
        expect(fs.existsSync(path.join(dir, "helper.md"))).toBe(false)
        expect(fs.readFileSync(path.join(dir, "Tsoul.md"), "utf8")).toBe(raw)
      }
    }),
  )

  it.instance("uses valid metadata id for a customized legacy Soul", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(
        path.join(dir, "Gsoul.md"),
        "---\nid: assistant\nname: My Assistant\n---\n\n# My Assistant\n\nbody\n",
      )
      expect(migrateLegacySouls(dir).defaults).toEqual({ tui: "karina", desktop: "assistant" })
    }),
  )

  it.instance("prefers valid source metadata identity over a conflicting heading", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "---\nid: helper\nname: Helper\n---\n\n# 柳智敏\n\nbody\n")
      const result = migrateLegacySouls(dir)
      expect(result.defaults).toEqual({ tui: "helper", desktop: "yuqi" })
      expect(fs.readFileSync(path.join(dir, "helper.md"), "utf8")).toContain('name: "Helper"')
    }),
  )

  it.instance("preserves an explicit metadata ID even when its name is official", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "---\nid: custom-karina\nname: 柳智敏\n---\n\nbody\n")
      expect(migrateLegacySouls(dir).defaults).toEqual({ tui: "custom-karina", desktop: "yuqi" })
    }),
  )

  it.instance("does not overwrite a V2 destination and makes the conflict visible", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "# 柳智敏\n\nold body\n")
      yield* write(path.join(dir, "karina.md"), official("id: karina\nname: 柳智敏") + "existing\n")
      const result = yield* Effect.sync(() => migrateLegacySouls(dir))
      expect(result.defaults).toEqual({ tui: "tsoul", desktop: "yuqi" })
      expect(result.issues.join(" ")).toContain("already exists")
      expect(fs.readFileSync(path.join(dir, "karina.md"), "utf8")).toContain("existing")
    }),
  )

  it.instance("selects the migrated canonical file before deduplicating metadata aliases", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "---\nid: helper\nname: Helper\n---\n\noriginal body\n")
      migrateLegacySouls(dir)
      const soul = yield* Soul.Service
      expect((yield* soul.get("helper").pipe(Effect.provideService(Soul.directory, dir)))?.path).toBe(
        path.join(dir, "helper.md"),
      )
      expect(yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))).toEqual([])
    }),
  )

  it.instance("preserves a conflicting metadata alias instead of selecting a different canonical body", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "---\nid: helper\nname: Helper\n---\n\noriginal body\n")
      yield* write(path.join(dir, "helper.md"), "---\nid: helper\nname: Helper\n---\n\ndifferent body\n")
      expect(migrateLegacySouls(dir).issues.join(" ")).toContain("already exists")
      const soul = yield* Soul.Service
      expect((yield* soul.get("helper").pipe(Effect.provideService(Soul.directory, dir)))?.content).toBe(
        "original body",
      )
      expect(
        (yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))).some((issue) =>
          issue.message.includes("duplicate"),
        ),
      ).toBe(true)
    }),
  )

  it.instance("does not suppress an alias that is its own marker target", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "tsoul.md"), "---\nid: tsoul\nname: Helper\n---\n\nbody\n")
      yield* write(path.join(dir, ".legacy-defaults.json"), JSON.stringify({ version: 1, defaults: { tui: "tsoul" } }))
      expect(
        (yield* (yield* Soul.Service).list().pipe(Effect.provideService(Soul.directory, dir))).map((item) => item.id),
      ).toEqual(["tsoul"])
    }),
  )

  it.instance("does not mark conflicting canonical identity metadata as an identical copy", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "---\nid: helper\nname: Original\n---\n\nsame body\n")
      yield* write(path.join(dir, "helper.md"), "---\nid: helper\nname: Different\n---\n\nsame body\n")
      expect(migrateLegacySouls(dir).issues.join(" ")).toContain("already exists")
      const info = yield* (yield* Soul.Service).get("helper").pipe(Effect.provideService(Soul.directory, dir))
      expect(info?.name).toBe("Original")
      expect(info?.path).toBe(path.join(dir, "Tsoul.md"))
    }),
  )

  it.instance("retains compiled legacy defaults when source files are absent without writing a marker", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "absent-souls")
      expect(migrateLegacySouls(dir).defaults).toEqual({ tui: "karina", desktop: "yuqi" })
      expect(fs.existsSync(path.join(dir, ".legacy-defaults.json"))).toBe(false)
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

  it.instance("rejects malformed partial metadata and oversized files during get", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "partial.md"), "---\nid: partial\n---\n\nbody\n")
      yield* write(path.join(dir, "big.md"), official("id: big\nname: 大") + "x".repeat(17 * 1024))
      const soul = yield* Soul.Service
      const issues = yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))
      expect(issues.map((issue) => issue.message).sort()).toEqual([
        "exceeds 16384 bytes",
        "invalid or incomplete metadata",
      ])
      expect(yield* soul.get("partial").pipe(Effect.provideService(Soul.directory, dir))).toBeUndefined()
      expect(yield* soul.get("big").pipe(Effect.provideService(Soul.directory, dir))).toBeUndefined()
    }),
  )

  it.instance("keeps aliases visible unless a valid migration marker points to a canonical target", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "# 柳智敏\n\nlegacy\n")
      yield* write(path.join(dir, "karina.md"), official("id: karina\nname: 柳智敏"))
      yield* write(path.join(dir, "chi.md"), official("id: chi\nname: 赤"))
      yield* write(path.join(dir, ".legacy-defaults.json"), JSON.stringify({ version: 1, defaults: { tui: "karina" } }))
      const list = yield* (yield* Soul.Service).list().pipe(Effect.provideService(Soul.directory, dir))
      expect(list.map((item) => item.id)).toEqual(["chi", "karina"])
    }),
  )

  it.instance("rejects unknown metadata keys and whitespace-only optional values visibly", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "unknown.md"), official("id: unknown\nname: Unknown\nlegacy_client: tui"))
      yield* write(path.join(dir, "blank.md"), official("id: blank\nname: Blank\ndisplay_name: '   '"))
      const soul = yield* Soul.Service
      expect(yield* soul.list().pipe(Effect.provideService(Soul.directory, dir))).toEqual([])
      expect((yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))).length).toBe(2)
    }),
  )

  it.instance("reports invalid description type and descriptions over 256 UTF-8 bytes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "bad-type.md"), official("id: bad-type\nname: Bad\ndescription: 42"))
      yield* write(path.join(dir, "too-long.md"), official(`id: too-long\nname: Long\ndescription: '${"你".repeat(86)}'`))
      const soul = yield* Soul.Service
      expect(yield* soul.list().pipe(Effect.provideService(Soul.directory, dir))).toEqual([])
      const issues = yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))
      expect(issues).toHaveLength(2)
      expect(issues.find((issue) => issue.path.endsWith("too-long.md"))?.message).toContain("description exceeds 256")
      expect(issues.find((issue) => issue.path.endsWith("bad-type.md"))?.message).toBe(
        "invalid or incomplete metadata",
      )
    }),
  )

  it.instance("reports corrupt legacy marker and does not suppress aliases", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "# Legacy\n\nbody\n")
      yield* write(path.join(dir, ".legacy-defaults.json"), "{broken")
      const soul = yield* Soul.Service
      expect((yield* soul.list().pipe(Effect.provideService(Soul.directory, dir))).map((item) => item.id)).toEqual([
        "tsoul",
      ])
      expect(
        (yield* soul.issues().pipe(Effect.provideService(Soul.directory, dir))).some((issue) =>
          issue.path.endsWith(".legacy-defaults.json"),
        ),
      ).toBe(true)
    }),
  )

  it.instance("ignores stale marker defaults and retains the source alias", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "Tsoul.md"), "# Legacy\n\nbody\n")
      yield* write(path.join(dir, ".legacy-defaults.json"), JSON.stringify({ version: 1, defaults: { tui: "karina" } }))
      const soul = yield* Soul.Service
      expect(yield* soul.defaultForClient("tui").pipe(Effect.provideService(Soul.directory, dir))).toBe("tsoul")
      expect((yield* soul.list().pipe(Effect.provideService(Soul.directory, dir))).map((item) => item.id)).toEqual([
        "tsoul",
      ])
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

  it.instance("details report frontmatter and legacy fallback provenance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(
        path.join(dir, "helper.md"),
        official("id: helper\nname: Helper\ndisplay_name: UI Helper\ncommit_prefix: HelperTag\ndescription: Details"),
      )
      yield* write(path.join(dir, "sparse.md"), official("id: sparse\nname: Sparse"))
      yield* write(path.join(dir, "Legacy.md"), "# Legacy Name · note\n\nlegacy body\n")

      const soul = yield* Soul.Service
      const officialDetails = yield* soul.details("helper").pipe(Effect.provideService(Soul.directory, dir))
      expect(officialDetails?.sources).toEqual({
        id: "frontmatter",
        name: "frontmatter",
        displayName: "frontmatter",
        commitPrefix: "frontmatter",
        avatar: "absent",
        description: "frontmatter",
      })
      const sparseDetails = yield* soul.details("sparse").pipe(Effect.provideService(Soul.directory, dir))
      expect(sparseDetails?.sources).toEqual({
        id: "frontmatter",
        name: "frontmatter",
        displayName: "fallback",
        commitPrefix: "fallback",
        avatar: "absent",
        description: "absent",
      })
      const legacyDetails = yield* soul.details("legacy").pipe(Effect.provideService(Soul.directory, dir))
      expect(legacyDetails?.sources).toEqual({
        id: "fallback",
        name: "fallback",
        displayName: "fallback",
        commitPrefix: "fallback",
        avatar: "absent",
        description: "absent",
      })
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

describe("soul create", () => {
  const runCreate = (dir: string, input: Soul.CreateInput) =>
    Effect.flatMap(Soul.Service, (soul) => soul.create(input).pipe(Effect.provideService(Soul.directory, dir)))

  it.instance("creates a structured Soul, returns its summary, and leaves defaults untouched", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const soul = yield* Soul.Service

      const created = yield* runCreate(dir, {
        id: "new-soul",
        name: "New: Soul #1",
        displayName: 'Quoted "Name"',
        commitPrefix: "NewTag",
        avatar: "avatar-key",
        description: "  short description  ",
        content: "# Body\n\nHello: world\n",
      })

      expect(created).toEqual({
        id: "new-soul",
        name: "New: Soul #1",
        displayName: 'Quoted "Name"',
        commitPrefix: "NewTag",
        avatar: "avatar-key",
        description: "short description",
      })
      const raw = fs.readFileSync(path.join(dir, "new-soul.md"), "utf8")
      expect(raw).toContain('id: "new-soul"')
      expect(raw).toContain('name: "New: Soul #1"')
      expect(raw).toContain('display_name: "Quoted \\"Name\\""')
      expect(raw).toContain("\n\n# Body\n\nHello: world\n")

      const info = yield* soul
        .get("new-soul")
        .pipe(Effect.provideService(Soul.directory, dir))
      expect(info).toMatchObject({
        id: "new-soul",
        name: "New: Soul #1",
        displayName: 'Quoted "Name"',
        commitPrefix: "NewTag",
        content: "# Body\n\nHello: world",
        path: path.join(dir, "new-soul.md"),
      })
      expect(yield* soul.defaultForClient("desktop").pipe(Effect.provideService(Soul.directory, dir))).toBe("yuqi")
    }),
  )

  it.instance("refuses to overwrite an existing Soul with the same id", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const input = { id: "duplicate", name: "First", content: "first body" }
      yield* runCreate(dir, input)
      const before = fs.readFileSync(path.join(dir, "duplicate.md"), "utf8")

      const error = yield* runCreate(dir, { ...input, name: "Second", content: "second body" }).pipe(Effect.flip)
      expect(error._tag).toBe("SoulConflict")
      expect(error.message).toContain("already exists")
      expect(fs.readFileSync(path.join(dir, "duplicate.md"), "utf8")).toBe(before)
    }),
  )

  it.instance("refuses an id already registered under a different filename", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(path.join(dir, "alias.md"), official("id: taken\nname: Taken"))

      const error = yield* runCreate(dir, { id: "taken", name: "Other", content: "body" }).pipe(Effect.flip)
      expect(error._tag).toBe("SoulConflict")
      expect((error as Soul.SoulConflict).path).toBe(path.join(dir, "alias.md"))
      expect(fs.existsSync(path.join(dir, "taken.md"))).toBe(false)
    }),
  )

  it.instance("rejects invalid structured input with a field-specific error", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const cases: [Soul.CreateStructuredInput, string][] = [
        [{ id: "Bad ID", name: "X", content: "body" }, "id"],
        [{ id: "blank-name", name: "   ", content: "body" }, "name"],
        [{ id: "blank-display", name: "X", displayName: "  ", content: "body" }, "displayName"],
        [{ id: "empty-body", name: "X", content: " \n" }, "content"],
        [{ id: "long-desc", name: "X", description: "你".repeat(86), content: "body" }, "description"],
        [{ id: "multi-desc", name: "X", description: "first\nsecond", content: "body" }, "description"],
        [{ id: "too-big", name: "X", content: "x".repeat(MAX_SOUL_BYTES) }, "content"],
      ]

      for (const [input, field] of cases) {
        const error = yield* runCreate(dir, input).pipe(Effect.flip)
        expect(error._tag).toBe("SoulInvalidInput")
        expect((error as Soul.SoulInvalidInput).field).toBe(field)
        expect(fs.existsSync(path.join(dir, `${input.id}.md`))).toBe(false)
      }
    }),
  )

  it.instance("accepts a complete Markdown document verbatim", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const markdown = `---\nid: "pasted-soul"\nname: "Pasted: Soul #1"\ndisplay_name: "Pasted"\ndescription: "a: b # c"\n---\n\n# Heading\n\nBody: with colon\n`
      const soul = yield* Soul.Service

      const created = yield* runCreate(dir, { markdown })
      expect(created).toEqual({
        id: "pasted-soul",
        name: "Pasted: Soul #1",
        displayName: "Pasted",
        commitPrefix: "Pasted",
        avatar: undefined,
        description: "a: b # c",
      })
      expect(fs.readFileSync(path.join(dir, "pasted-soul.md"), "utf8")).toBe(markdown)
      expect(
        (yield* soul.get("pasted-soul").pipe(Effect.provideService(Soul.directory, dir)))?.content,
      ).toBe("# Heading\n\nBody: with colon")
    }),
  )

  it.instance("rejects Markdown the registry cannot parse or would not list", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const cases = [
        "# Just body\n",
        official('id: "Bad ID"\nname: Bad'),
        official("id: unknown\nname: Unknown\nlegacy_client: tui"),
        "---\nid: empty\nname: Empty\n---\n\n   \n",
        official(`id: long\nname: Long\ndescription: '${"你".repeat(86)}'`),
        "x".repeat(MAX_SOUL_BYTES + 1),
      ]

      for (const markdown of cases) {
        const error = yield* runCreate(dir, { markdown }).pipe(Effect.flip)
        expect(error._tag).toBe("SoulInvalidInput")
      }
      expect(fs.existsSync(path.join(dir, "long.md"))).toBe(false)
    }),
  )

  // 261113 Red 粘贴导入是最直接的外部输入入口：`---js` frontmatter 必须在解析前拒绝，
  // 失败也不能落盘——解析副作用无法撤回，只靠后续字段校验拦不住。
  it.instance("rejects executable frontmatter before parsing and never writes the file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      const probe = "__red_soul_frontmatter_probe"
      const payload = `globalThis["${probe}"] = "executed"`

      const error = yield* runCreate(dir, { markdown: `---js\n${payload}\n---\n\n# x\nbody\n` }).pipe(Effect.flip)
      expect(error._tag).toBe("SoulInvalidInput")
      expect((error as Soul.SoulInvalidInput).message).toContain("unsupported frontmatter language")
      expect(readProbe(probe)).toBeUndefined()

      const bomError = yield* runCreate(dir, { markdown: `\uFEFF---js\n${payload}\n---\n\n# x\nbody\n` }).pipe(Effect.flip)
      expect(bomError._tag).toBe("SoulInvalidInput")
      expect(readProbe(probe)).toBeUndefined()

      // 失败在 mkdir 之前返回，目录可能尚不存在：无论哪种情况都不能有任何 .md 落盘
      const written = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".md")) : []
      expect(written).toEqual([])
    }),
  )

  it.instance("reports registry IO failures separately from invalid input", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "souls")
      yield* write(dir, "not a directory")

      const error = yield* runCreate(dir, { id: "io-soul", name: "IO", content: "body" }).pipe(Effect.flip)
      expect(error._tag).toBe("SoulIO")
      expect(error.message).toContain('could not create Soul "io-soul"')
    }),
  )
})
