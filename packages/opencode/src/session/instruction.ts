import path from "path"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@redcode-ai/core/flag/flag"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@redcode-ai/core/global"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

// 260613 Red removed recentSessionDigest — replaced by chat room, was token-heavy

const files = (disableClaudeCodePrompt: boolean) => [
  "AGENTS.md",
  ...(disableClaudeCodePrompt ? [] : ["CLAUDE.md"]),
  "CONTEXT.md", // deprecated
]

function extract(messages: MessageV2.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, AppFileSystem.Error>
  readonly system: () => Effect.Effect<string[], AppFileSystem.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, AppFileSystem.Error>
  readonly resolve: (
    messages: MessageV2.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], AppFileSystem.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = files(flags.disableClaudeCodePrompt)

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
        }),
      ),
    )

    // 260613 Red cache digest once per session to keep system prompt stable for prefix caching.
    // Recomputing every turn changes time_updated/title/stats → invalidates DeepSeek prefix cache
    // → all conversation messages after the mismatch point become uncached → hit rate drops over time.

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.REDCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.REDCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      // 260611 Red project memory: .redcode/MEMORY.md (project) → ~/.redcode/MEMORY.md (global fallback)
      // 260729 Red 改成叠加，不再互斥。原先项目级存在就完全不加载全局那份，但两者语义正交：
      //   全局 = 跨项目、跨会话踩过的通用坑；项目 = 本项目特有问题 + 工作进度。
      //   互斥的后果是静默的——只写在全局的规则，在任何有 .redcode/MEMORY.md 的项目里
      //   结构性缺席，而且从会话里完全看不出来（实测本机全局 19KB、RedCode 项目级 7KB，
      //   在 RedCode 里那 19KB 一个字都没进过 prompt）。
      // 顺序：全局在前、项目在后 —— 通用规则打底，项目特有的写在后面，既符合"具体覆盖一般"
      //   的阅读直觉，也让更常变动的那份靠近尾部，少动前面已缓存的前缀。
      // paths 是 Set 且存的是 resolve 后的绝对路径，万一两者指向同一个文件会自动去重。
      {
        const globalMemory = path.join(global.config, "MEMORY.md")
        if (yield* fs.existsSafe(globalMemory)) paths.add(path.resolve(globalMemory))

        if (!Flag.REDCODE_DISABLE_PROJECT_CONFIG) {
          // 260729 Red 不能直接用 ctx.worktree —— 目录不是 git 仓库时它是文件系统根 "/"，
          // path.join("/", ".redcode", "MEMORY.md") 会算成 <当前盘>:\.redcode\MEMORY.md。
          // 后果是双向的：读会去盘符根读，写也会写到盘符根。本机 C:/D:/E: 三个盘根下都留着
          // 一整套被 scaffold 出来的 .redcode/（MEMORY.md + .gitignore + package.json +
          // node_modules），就是这么来的。非 git 项目退回 ctx.directory 作为项目根。
          const root = ctx.worktree && ctx.worktree !== path.parse(ctx.worktree).root ? ctx.worktree : ctx.directory
          const projectMemory = path.join(root, ".redcode", "MEMORY.md")
          if (yield* fs.existsSafe(projectMemory)) paths.add(path.resolve(projectMemory))
        }
      }

      // 260611 Red auto-inject soul based on TUI/GUI mode
      {
        const soulFile = flags.client === "desktop" ? "Gsoul.md" : "Tsoul.md"
        const soulPath = path.join(global.home, ".redcode", "souls", soulFile)
        if (yield* fs.existsSafe(soulPath)) paths.add(path.resolve(soulPath))
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: MessageV2.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, systemPaths, system, find, resolve })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export function loaded(messages: MessageV2.WithParts[]) {
  return extract(messages)
}

export * as Instruction from "./instruction"
