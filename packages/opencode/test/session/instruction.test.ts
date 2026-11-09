import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instruction, isWithinRoot } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@redcode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
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

  // 261109 Karina RC-01：项目根是 <parent>/proj，文件在 <parent>/proj-backup/nested。
  // 旧实现用 current.startsWith(root) 判断包含关系，前缀相同的兄弟目录会被判成项目内，
  // 沿 sibling 向上找到 proj-backup/AGENTS.md 并当本项目指令注入。
  it.live("does not attach instructions from a sibling sharing the project name prefix", () =>
    Effect.gen(function* () {
      const parent = yield* tmpdirScoped()
      const project = path.join(parent, "proj")
      const sibling = path.join(parent, "proj-backup")
      yield* writeFiles(project, { "AGENTS.md": "# Project rules" })
      yield* writeFiles(sibling, { "AGENTS.md": "# Sibling rules", "nested/file.ts": "const x = 1" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const results = yield* svc.resolve(
          [],
          path.join(sibling, "nested", "file.ts"),
          MessageID.make("msg_message-path-sibling-1"),
        )
        expect(results).toEqual([])
      }).pipe(provideInstance(project), provideInstruction({ home: project, config: project }))
    }),
  )

  // 261109 Karina RC-01：find() 走逻辑路径、读的是链接目标。项目内的目录联接如果指向
  // 根之外，逻辑路径判定会放行，真实路径判定必须拦住。
  it.live("does not attach instructions reached through a link pointing outside the project", () =>
    Effect.gen(function* () {
      const parent = yield* tmpdirScoped()
      const project = path.join(parent, "proj")
      const outside = path.join(parent, "outside")
      const link = path.join(project, "link")
      yield* writeFiles(project, { "keep.txt": "keep" })
      yield* writeFiles(outside, { "AGENTS.md": "# Outside rules", "file.ts": "const x = 1" })
      yield* Effect.promise(() => fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir"))
      // 先摘链接再让 tmpdirScoped 递归清理：Windows 上 rm -r 会顺着目录联接走进目标。
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(link, { recursive: true, force: true })).pipe(Effect.ignore),
      )

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const results = yield* svc.resolve(
          [],
          path.join(link, "file.ts"),
          MessageID.make("msg_message-path-link-1"),
        )
        expect(results).toEqual([])
      }).pipe(provideInstance(project), provideInstruction({ home: project, config: project }))
    }),
  )

  test.todo("fetches remote instructions from config URLs via HttpClient", () => {})
})

// 261109 Karina RC-01：路径包含判定不能是字符串前缀。这些用例钉住路径语义本身
// （跨盘符、大小写、父级穿越），行为用例在上面。
describe("Instruction.isWithinRoot", () => {
  const root = path.resolve(process.platform === "win32" ? "C:/work/RedCode" : "/work/RedCode")

  test("accepts a descendant directory", () => {
    expect(isWithinRoot(root, path.join(root, "src", "nested"))).toBe(true)
  })

  test("rejects the root itself", () => {
    expect(isWithinRoot(root, root)).toBe(false)
  })

  test("rejects a sibling sharing the project name prefix", () => {
    expect(isWithinRoot(root, `${root}-backup`)).toBe(false)
  })

  test("rejects parent traversal", () => {
    expect(isWithinRoot(root, path.join(root, ".."))).toBe(false)
  })

  test("compares case-insensitively on Windows", () => {
    if (process.platform !== "win32") return
    expect(isWithinRoot(root, path.join(root.toUpperCase(), "src"))).toBe(true)
  })

  test("rejects a path on another drive", () => {
    if (process.platform !== "win32") return
    const other = path.parse(root).root === "C:\\" ? "D:\\work\\RedCode" : "C:\\work\\RedCode"
    expect(isWithinRoot(root, other)).toBe(false)
  })

  test("handles UNC paths on Windows", () => {
    if (process.platform !== "win32") return
    // 同一共享下的子目录算项目内，同前缀兄弟目录与别的共享都不算
    expect(isWithinRoot("\\\\server\\share\\proj", "\\\\server\\share\\proj\\src")).toBe(true)
    expect(isWithinRoot("\\\\server\\share\\proj", "\\\\server\\share\\proj-backup")).toBe(false)
    expect(isWithinRoot("\\\\server\\share\\proj", "\\\\other\\share\\proj\\src")).toBe(false)
  })
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

  // 261007 Red Soul 已从 Instruction 独立管理；这里验证其余 instruction 来源的优先级。
  it.live("keeps AGENTS ahead of MEMORY when the instruction budget is tight", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({
        "AGENTS.md": agents(1000),
        // 全局 MEMORY 是 <config>/MEMORY.md（不是 .redcode/ 下那份——那是项目级）
        "MEMORY.md": agents(800),
      })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        // 必须只看来源本体：声明行里也含被丢来源的路径，混在一起会让断言因错误的原因通过
        const kept = rules.filter((r) => r.startsWith("Instructions from:"))
        // 预算 1500 < 两个来源正文合计 1800：MEMORY 先丢，AGENTS 完整保留。
        expect(kept.some((r) => r.includes("MEMORY.md"))).toBe(false)
        // AGENTS(0) 完整保留——漏一条硬规则比前缀长更糟
        expect(kept.some((r) => r.includes(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}`))).toBe(true)
        // 被丢的 MEMORY 仍要进模型可见声明行，不能静默
        const notice = rules.find((r) => r.includes("instruction source(s) dropped"))!
        expect(notice).toContain("MEMORY.md")
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
          instruction_budget: { max_total_bytes: 1500 },
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
      yield* writeFiles(extra, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${long}${i}.md`, agents(50)])))

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

  it.live("does not discover legacy client-specific Soul files", () =>
    withFiles({ ".redcode/souls/Tsoul.md": "# TUI", ".redcode/souls/Gsoul.md": "# GUI" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(dir, ".redcode", "souls", "Tsoul.md"))).toBe(false)
        expect(paths.has(path.join(dir, ".redcode", "souls", "Gsoul.md"))).toBe(false)
      }),
    ),
  )
})

// 261107 Red describe() 与 system() 共用 evaluate() 预算管线；这里断言的是清单投影的
// 命运语义。与上面同理，只按路径断言「该在的在、命运对」，不数总数。
describe("Instruction.describe", () => {
  it.live("reports injected sources with raw and effective bytes", () =>
    withFiles({ "AGENTS.md": "# Project rules" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const inv = yield* svc.describe()
        const source = inv.sources.find((s) => s.path === path.join(dir, "AGENTS.md"))
        expect(source).toBeDefined()
        expect(source!.status).toBe("injected")
        expect(source!.kind).toBe("agents")
        expect(source!.bytes).toBe(Buffer.byteLength("# Project rules"))
        expect(source!.effectiveBytes).toBe(
          Buffer.byteLength(`Instructions from: ${path.join(dir, "AGENTS.md")}\n# Project rules`),
        )
        expect(inv.totalBytes).toBeGreaterThanOrEqual(source!.effectiveBytes!)
        expect(inv.budget.maxSourceBytes).toBe(1024 * 1024)
      }),
    ),
  )

  it.live("marks dropped and truncated fates under max_total_bytes", () =>
    withFiles(
      { "AGENTS.md": "# Project rules here", "MEMORY.md": "# Memory lessons here" },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const inv = yield* svc.describe()
          const byPath = new Map(inv.sources.map((s) => [s.path, s]))
          // RETENTION：memory(1) 比 agents(0) 先被丢；独苗超总预算时截断（marker 追加在
          // 预算之后，最终字节允许超 maxTotalBytes——system() 的既有行为，清单如实反映）。
          expect(byPath.get(path.join(dir, "MEMORY.md"))?.status).toBe("dropped")
          const agents = byPath.get(path.join(dir, "AGENTS.md"))
          expect(agents?.status).toBe("truncated")
          expect(agents?.effectiveBytes).toBeDefined()
          expect(inv.budget.maxTotalBytes).toBe(20)
        }),
      { instruction_budget: { max_total_bytes: 20 } },
    ),
  )
})

// 261107 Red RC-04 审计要求的重点验证：远程 instructions + 多份 AGENTS.md + MEMORY.md
// 同时触发预算淘汰时，describe() 清单必须与真正发给模型的内容逐项一致——否则这个
// 功能就是「看起来准确、实际上误导人」的诊断面板。断言全部走互证：注入集合相等、
// 淘汰集合不出现在注入文本、淘汰名单完整出现在预算标记行、totalBytes 与注入文本
// 字节和相等。文件尺寸刻意留出余量，断言不依赖 tmpdir 路径长度。
describe("Instruction.describe 与 system 逐项一致（RC-04）", () => {
  it.live("预算淘汰下清单与注入文本互证", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global rules", "MEMORY.md": "# Memory lessons" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project rules" })
      const server = Bun.serve({ port: 0, fetch: () => new Response("# Remote rules from afar") })
      const url = `http://127.0.0.1:${server.port}/rules`
      try {
        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const parts = yield* svc.system()
          const inv = yield* svc.describe()
          const prefix = "Instructions from: "
          const injectedFromParts = parts
            .filter((p) => p.startsWith(prefix))
            .map((p) => p.slice(prefix.length, p.indexOf("\n")))
          const injectedFromDescribe = inv.sources.filter((s) => s.status === "injected").map((s) => s.path)
          const droppedFromDescribe = inv.sources.filter((s) => s.status === "dropped").map((s) => s.path)

          // 淘汰必须真的发生，否则这条测试没在验证它声称的场景。
          expect(droppedFromDescribe.length).toBeGreaterThan(0)
          // 互证 1：注入集合与顺序逐项相等。
          expect(injectedFromDescribe).toEqual(injectedFromParts)
          // 互证 2：淘汰的来源绝不出现在注入文本。
          for (const dropped of droppedFromDescribe) {
            expect(injectedFromParts).not.toContain(dropped)
          }
          // 互证 3：每一条淘汰都在模型可见的预算标记行里报过名字。
          const marker = parts.find((p) => p.startsWith("[instruction budget]"))
          expect(marker).toBeDefined()
          for (const dropped of droppedFromDescribe) {
            expect(marker!).toContain(dropped)
          }
          // 互证 4：清单的 totalBytes 与注入文本的字节和相等。
          const injectedBytes = parts
            .filter((p) => p.startsWith(prefix))
            .reduce((sum, p) => sum + Buffer.byteLength(p), 0)
          expect(inv.totalBytes).toBe(injectedBytes)
          // kind 归属正确：URL 是 config，AGENTS.md 是 agents，MEMORY.md 是 memory。
          const byPath = new Map(inv.sources.map((s) => [s.path, s]))
          expect(byPath.get(url)?.kind).toBe("config")
          expect(byPath.get(path.join(globalTmp, "AGENTS.md"))?.kind).toBe("agents")
          expect(byPath.get(path.join(globalTmp, "MEMORY.md"))?.kind).toBe("memory")
        }).pipe(
          provideInstance(projectTmp),
          provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
            instruction_budget: { max_total_bytes: 260 },
            instructions: [url],
          }),
        )
      } finally {
        server.stop(true)
      }
    }),
  )
})

// 261109 Karina RC-01：远程指令的读取上限必须在「读」的时候就生效。旧实现先
// arrayBuffer 整份载入内存、再按解码后的字节数丢弃——内存仍随响应体线性增长，
// chunked 响应连 Content-Length 兜底都没有。这组用例用本地服务验证：正常短文本
// 注入、超限整份丢弃并取消响应流、声明超限提前拒绝、慢响应按时超时、断流不注入半截。
describe("Instruction remote fetch budget (RC-01)", () => {
  it.live("injects a short remote instruction", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpdirScoped()
      const server = Bun.serve({ port: 0, fetch: () => new Response("# Remote rules") })
      const url = `http://127.0.0.1:${server.port}/rules`
      try {
        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const rules = yield* svc.system()
          expect(rules.some((r) => r.includes("# Remote rules"))).toBe(true)
        }).pipe(
          provideInstance(projectTmp),
          provideInstruction({ home: globalTmp, config: globalTmp }, undefined, { instructions: [url] }),
        )
      } finally {
        server.stop(true)
      }
    }),
  )

  it.live("stops reading a chunked response once it exceeds max_source_bytes", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpdirScoped()
      const chunk = new Uint8Array(64 * 1024).fill(0x78)
      // 50 块 × 50ms ≈ 2.5s：预算 1KB 时第一块就越限。「读的时候截断」会立刻返回，
      // 「读完再丢」的旧实现要接近 2.5s——用耗时把两条路径区分开。
      const server = Bun.serve({
        port: 0,
        fetch() {
          let sent = 0
          return new Response(
            new ReadableStream({
              async pull(controller) {
                if (sent >= 50) return controller.close()
                sent += 1
                await Bun.sleep(50)
                controller.enqueue(chunk)
              },
            }),
          )
        },
      })
      const url = `http://127.0.0.1:${server.port}/stream`
      try {
        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const started = Date.now()
          const rules = yield* svc.system()
          expect(rules.some((r) => r.startsWith(`Instructions from: ${url}`))).toBe(false)
          expect(Date.now() - started).toBeLessThan(1500)
        }).pipe(
          provideInstance(projectTmp),
          provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
            instructions: [url],
            instruction_budget: { max_source_bytes: 1024, fetch_timeout_ms: 10000 },
          }),
        )
      } finally {
        server.stop(true)
      }
    }),
  )


  it.live("rejects a response whose Content-Length already exceeds the budget", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpdirScoped()
      // 声明 200000 字节但一个字节都不发：只有按 Content-Length 提前拒绝才能在
      // fetch_timeout_ms 之前返回；只按实际读取字节的实现会一直等到超时。
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open() {},
          data(socket) {
            socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 200000\r\n\r\n")
          },
        },
      })
      const url = `http://127.0.0.1:${server.port}/big`
      try {
        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const started = Date.now()
          const rules = yield* svc.system()
          expect(Date.now() - started).toBeLessThan(1000)
          expect(rules.some((r) => r.startsWith(`Instructions from: ${url}`))).toBe(false)
        }).pipe(
          provideInstance(projectTmp),
          provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
            instructions: [url],
            instruction_budget: { max_source_bytes: 1024, fetch_timeout_ms: 5000 },
          }),
        )
      } finally {
        server.stop(true)
      }
    }),
  )

  it.live("times out on a stalled body without hanging the session", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpdirScoped()
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response(
            new ReadableStream({
              pull() {
                return new Promise<never>(() => {})
              },
            }),
          )
        },
      })
      const url = `http://127.0.0.1:${server.port}/stall`
      try {
        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const started = Date.now()
          const rules = yield* svc.system()
          expect(Date.now() - started).toBeLessThan(5000)
          expect(rules.some((r) => r.startsWith(`Instructions from: ${url}`))).toBe(false)
        }).pipe(
          provideInstance(projectTmp),
          provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
            instructions: [url],
            instruction_budget: { fetch_timeout_ms: 150 },
          }),
        )
      } finally {
        server.stop(true)
      }
    }),
  )

  it.live("times out on a stalled body without hanging the session", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpdirScoped()
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response(
            new ReadableStream({
              pull() {
                return new Promise<never>(() => {})
              },
            }),
          )
        },
      })
      const url = `http://127.0.0.1:${server.port}/stall`
      try {
        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const started = Date.now()
          const rules = yield* svc.system()
          expect(Date.now() - started).toBeLessThan(5000)
          expect(rules.some((r) => r.startsWith(`Instructions from: ${url}`))).toBe(false)
        }).pipe(
          provideInstance(projectTmp),
          provideInstruction({ home: globalTmp, config: globalTmp }, undefined, {
            instructions: [url],
            instruction_budget: { fetch_timeout_ms: 150 },
          }),
        )
      } finally {
        server.stop(true)
      }
    }),
  )

  it.live("never injects a partial body when the connection drops mid-response", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpdirScoped()
      // 声明 1000 字节，只发 16 字节就断开：客户端很可能已收到半截正文，
      // 但必须整份丢弃，不能把 "# Partial rules" 当完整指令注入。
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open() {},
          data(socket) {
            socket.write(
              "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n# Partial rules",
            )
            socket.end()
          },
        },
      })
      const url = `http://127.0.0.1:${server.port}/broken`
      try {
        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const rules = yield* svc.system()
          expect(rules.some((r) => r.includes("# Partial rules"))).toBe(false)
        }).pipe(
          provideInstance(projectTmp),
          provideInstruction({ home: globalTmp, config: globalTmp }, undefined, { instructions: [url] }),
        )
      } finally {
        server.stop(true)
      }
    }),
  )
})
