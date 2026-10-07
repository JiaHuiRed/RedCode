import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@redcode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import type { Config } from "@/config/config"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer))

const instructionLayer = (
  global: Partial<Global.Interface>,
  flags: Partial<RuntimeFlags.Info> = {},
  config: Config.Info = {},
) =>
  Instruction.layer.pipe(
    Layer.provide(TestConfig.layer({ get: () => Effect.succeed(config) })),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Global.layerWith(global)),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>, config?: Config.Info) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags, config)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(
  files: Record<string, string>,
  self: (dir: string) => Effect.Effect<A, E, R>,
  config: Config.Info = {},
) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }, undefined, config))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): MessageV2.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderID.make("anthropic"),
          modelID: ModelID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("skips a nested instruction larger than max_source_bytes", () =>
    withFiles(
      {
        "subdir/AGENTS.md": "敏".repeat(400),
        "subdir/nested/file.ts": "const x = 1",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const results = yield* svc.resolve(
            [],
            path.join(dir, "subdir", "nested", "file.ts"),
            MessageID.make("msg_message-budget-source-1"),
          )

          expect(results).toEqual([])
        }),
      { instruction_budget: { max_source_bytes: 1024 } },
    ),
  )

  it.live("caps the total bytes attached from nested instructions", () =>
    withFiles(
      {
        "subdir/AGENTS.md": "outer".repeat(140),
        "subdir/nested/AGENTS.md": "inner".repeat(140),
        "subdir/nested/file.ts": "const x = 1",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const results = yield* svc.resolve(
            [],
            path.join(dir, "subdir", "nested", "file.ts"),
            MessageID.make("msg_message-budget-total-1"),
          )

          expect(results).toHaveLength(1)
          expect(results[0].filepath).toBe(path.join(dir, "subdir", "nested", "AGENTS.md"))
        }),
      { instruction_budget: { max_resolved_bytes: 1024 } },
    ),
  )

  test.todo("fetches remote instructions from config URLs via HttpClient", () => {})
})

describe("Instruction.system", () => {
  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        // 260929 Red rules[0] 是引擎加的 OVERRIDE 声明行，来源从 1 开始。
        expect(rules[0]).toBe("The instructions below OVERRIDE any default behavior when they conflict.")
        expect(rules[1]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[2]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )
})

// 260729 Red MEMORY.md 此前零覆盖 —— 正因如此，"项目级存在就完全不加载全局那份"这个
// 静默缺陷从 260611 加进去起一直没被发现。两者语义正交（全局=跨项目通用坑，项目=本项目
// 特有问题+进度），必须共存。
describe("Instruction.system MEMORY.md", () => {
  // 断言"该在的在、顺序对"，不断言总条数 —— 环境里可能还有别的指令文件被带进来，
  // 数总数会让测试因无关原因假失败（既有的两条 Instruction.system 测试正是这么挂的）。
  it.live("全局与项目 MEMORY.md 同时存在时两份都加载，全局在前", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "MEMORY.md": "# Global Memory" })
      const projectTmp = yield* tmpWithFiles({ ".redcode/MEMORY.md": "# Project Memory" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "MEMORY.md"))).toBe(true)
        expect(paths.has(path.join(projectTmp, ".redcode", "MEMORY.md"))).toBe(true)

        const rules = yield* svc.system()
        const globalAt = rules.findIndex((r) => r.includes("# Global Memory"))
        const projectAt = rules.findIndex((r) => r.includes("# Project Memory"))
        expect(globalAt).toBeGreaterThanOrEqual(0)
        expect(projectAt).toBeGreaterThanOrEqual(0)
        expect(globalAt).toBeLessThan(projectAt)
        expect(rules[globalAt]).toBe(`Instructions from: ${path.join(globalTmp, "MEMORY.md")}\n# Global Memory`)
        expect(rules[projectAt]).toBe(
          `Instructions from: ${path.join(projectTmp, ".redcode", "MEMORY.md")}\n# Project Memory`,
        )
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("只有全局 MEMORY.md 时照常加载", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "MEMORY.md": "# Global Memory" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "MEMORY.md"))).toBe(true)
        expect((yield* svc.system()).some((r) => r.includes("# Global Memory"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("只有项目 MEMORY.md 时照常加载", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpWithFiles({ ".redcode/MEMORY.md": "# Project Memory" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, ".redcode", "MEMORY.md"))).toBe(true)
        expect((yield* svc.system()).some((r) => r.includes("# Project Memory"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})

// 260913 Red instruction_budget 是配置字段，必须验证它真被读到，而不是恒用缺省值。
describe("Instruction.system instruction_budget", () => {
  const big = "x".repeat(2000)

  it.live("skips a source larger than max_source_bytes", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": big })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        expect(rules.some((r) => r.includes("# Global Instructions"))).toBe(true)
        expect(rules.some((r) => r.includes(big))).toBe(false)
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
          instruction_budget: { max_source_bytes: 1024 },
        }),
      )
    }),
  )

  it.live("injects a source within the configured limit", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": big })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        expect(rules.some((r) => r.includes(big))).toBe(true)
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
          instruction_budget: { max_source_bytes: 8192 },
        }),
      )
    }),
  )
})

// 260929 Red 总量上限从「只告警」改为执行，必须验证它真的执行，并且执行方式是对的：
// 丢整份来源（不切半截）、被丢的进模型可见声明行、优先级低的先丢。
describe("Instruction.system max_total_bytes", () => {
 const agents = (n: number) => `# ${"x".repeat(n)}`

 it.live("drops the lowest-priority source when the total exceeds the budget", () =>
   Effect.gen(function* () {
     const globalTmp = yield* tmpWithFiles({ "AGENTS.md": agents(1000) })
     const projectTmp = yield* tmpWithFiles({ "AGENTS.md": agents(1000) })

     yield* Effect.gen(function* () {
       const svc = yield* Instruction.Service
       const rules = yield* svc.system()
       // 两份各约 1KB，预算 1.5KB → 后注入的项目级被整份丢掉，全局级完整保留
       expect(rules.some((r) => r.includes(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}`))).toBe(true)
       expect(rules.some((r) => r.includes(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}`))).toBe(false)
       // 被丢的来源必须进模型可见声明行——静默丢弃比前缀长更糟
       const notice = rules.find((r) => r.includes("[instruction budget]"))
       expect(notice).toBeDefined()
       expect(notice).toContain(path.join(projectTmp, "AGENTS.md"))
       // 保留的那份必须是完整的，没有被切半截
       const kept = rules.find((r) => r.includes(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}`))!
       expect(kept).toContain(agents(1000))
     }).pipe(
       provideInstance(projectTmp),
       provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
         instruction_budget: { max_total_bytes: 1500 },
       }),
     )
   }),
 )

 it.live("truncates the only source with an explicit marker instead of dropping everything", () =>
   Effect.gen(function* () {
     const globalTmp = yield* tmpWithFiles({ "AGENTS.md": agents(4000) })
     const projectTmp = yield* tmpdirScoped()

     yield* Effect.gen(function* () {
       const svc = yield* Instruction.Service
       const rules = yield* svc.system()
       // 只剩一个来源仍然超限：不能整份丢光（那就什么指令都没了），截断它本身并带标记
       expect(rules.some((r) => r.includes(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}`))).toBe(true)
       expect(rules.some((r) => r.includes("truncated at 2000 bytes"))).toBe(true)
       // 截断后的正文必须短于上限 + 标记行，不会把整个超限内容原样留下
       const kept = rules.find((r) => r.includes(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}`))!
       expect(new TextEncoder().encode(kept).byteLength).toBeLessThan(2000 + 400)
     }).pipe(
       provideInstance(projectTmp),
       provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
         instruction_budget: { max_total_bytes: 2000 },
       }),
     )
   }),
 )

 it.live("keeps everything when the total is within the budget", () =>
   Effect.gen(function* () {
     const globalTmp = yield* tmpWithFiles({ "AGENTS.md": agents(100) })
     const projectTmp = yield* tmpWithFiles({ "AGENTS.md": agents(100) })

     yield* Effect.gen(function* () {
       const svc = yield* Instruction.Service
       const rules = yield* svc.system()
       expect(rules.some((r) => r.includes(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}`))).toBe(true)
       expect(rules.some((r) => r.includes(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}`))).toBe(true)
       // 预算内不出现任何声明行
       expect(rules.some((r) => r.includes("[instruction budget]"))).toBe(false)
     }).pipe(
       provideInstance(projectTmp),
       provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
         instruction_budget: { max_total_bytes: 64 * 1024 },
       }),
     )
   }),
 )

  // 260929 Red 保留优先级与注入顺序是两个维度，必须分开验证。顺序没变（输出仍是
  // 全局 AGENTS → 项目 AGENTS → 全局 MEMORY → 项目 MEMORY → soul → config），
  // 但「谁先被丢」现在是显式设计的结果，不再是数组尾部的偶然。
  // 261007 Red 重排后 soul 先于 MEMORY 保留（MEMORY 是索引层，全文在召回库可查；
  // soul 丢了没有任何补救通道），本用例改为验证这条新顺序。
  it.live("keeps soul ahead of short-term MEMORY when the budget is tight", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({
        "AGENTS.md": agents(1000),
        // 全局 MEMORY 是 <config>/MEMORY.md（不是 .redcode/ 下那份——那是项目级）
        "MEMORY.md": agents(800),
        ".redcode/souls/Tsoul.md": agents(300),
      })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        // 必须只看来源本体：声明行里也含被丢来源的路径，混在一起会让断言因错误的原因通过
        const kept = rules.filter((r) => r.startsWith("Instructions from:"))
        // 预算 2000 < 总量约 2.2KB：MEMORY(2) 先于 soul(1) 被丢
        expect(kept.some((r) => r.includes("Tsoul.md"))).toBe(true)
        expect(kept.some((r) => r.includes("MEMORY.md"))).toBe(false)
        // AGENTS(0) 完整保留——漏一条硬规则比前缀长更糟
        expect(kept.some((r) => r.includes(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}`))).toBe(true)
        // 被丢的 MEMORY 仍要进模型可见声明行，不能静默
        const notice = rules.find((r) => r.includes("instruction source(s) dropped"))!
        expect(notice).toContain("MEMORY.md")
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
          instruction_budget: { max_total_bytes: 2000 },
        }),
      )
    }),
  )

  // 260929 Red 声明行自己也要有硬上限。dropped 的来源名来自 config.instructions，
  // 那是 Schema.Array(String)、没有长度上限——12 条 150 字符的路径直接 join 会得到
  // 2.8KB 的声明行，把「输出 ≤ maxTotalBytes + 有界标记」这个承诺变成假话。
  // 上一轮我正是这么写的，那句是过度乐观。
  it.live("caps the dropped-source notice so the marker itself cannot blow the budget", () =>
    Effect.gen(function* () {
      const long = "z".repeat(150)
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": agents(4000) })
      const projectTmp = yield* tmpdirScoped()
      const extra = yield* tmpdirScoped()
      yield* writeFiles(
        extra,
        Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${long}${i}.md`, agents(50)])),
      )

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        const notice = rules.find((r) => r.includes("instruction source(s) dropped"))!
        expect(notice).toBeDefined()
        // 12 条来源，每条路径 200+ 字节：无上限时声明行约 2.8KB
        expect(new TextEncoder().encode(notice).byteLength).toBeLessThanOrEqual(2048)
        // 必须真的折叠了——12 条全列出来才是原缺陷（dropped.join(", ")）
        const names = Array.from({ length: 12 }, (_, i) => `${long}${i}.md`)
        const listed = names.filter((name) => notice.includes(name)).length
        expect(listed).toBeLessThan(12)
        expect(notice).toMatch(/and \d+ more/)
        // 上界由列举阶段保证，所以不该走到兜底截断：结尾必须是完整句子，
        // 而不是被切成看似合法路径前缀的省略形态
        expect(notice.endsWith("if one of them matters.")).toBe(true)
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
          instructions: Array.from({ length: 12 }, (_, i) => path.join(extra, `${long}${i}.md`)),
          instruction_budget: { max_total_bytes: 2000 },
        }),
      )
    }),
  )

 // 260929 Red CJK 截断必须按字节而不是字符数：一个汉字 3 字节，按字符切会把
 // 多字节序列切成乱码，模型看到替换字符而不是指令。
 it.live("truncates CJK content on a character boundary", () =>
   Effect.gen(function* () {
     const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "敏".repeat(2000) })
     const projectTmp = yield* tmpdirScoped()

     yield* Effect.gen(function* () {
       const svc = yield* Instruction.Service
       const rules = yield* svc.system()
       const kept = rules.find((r) => r.includes(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}`))!
       // 6000 字节的中文被截到 3000：不能出现 U+FFFD 替换字符
       expect(kept).not.toContain("\uFFFD")
       expect(new TextEncoder().encode(kept).byteLength).toBeLessThan(3000 + 400)
     }).pipe(
       provideInstance(projectTmp),
       provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
         instruction_budget: { max_total_bytes: 3000 },
       }),
     )
   }),
 )
})
