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
import * as Log from "@redcode-ai/core/util/log"
import { projectRoot } from "@/project/root"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

// 260613 Red removed recentSessionDigest — replaced by chat room, was token-heavy

// 260916 Red 指令注入面预算。四个阈值都能从配置的 instruction_budget 覆盖，
// 这里只是缺省值：单来源超限跳过（不注入半截内容）、系统总量超限告警、
// read 附带的 nearby 指令总量硬上限、远程抓取限时。
// See docs/notes/implemented/bug-fix/2026-09-16-nearby-instruction-budget.md.
const DEFAULT_INSTRUCTION_BUDGET = {
  maxSourceBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024,
  maxResolvedBytes: 32 * 1024,
  fetchTimeoutMs: 5_000,
} as const

const bytes = (content: string) => new TextEncoder().encode(content).byteLength

// 260929 Red 按字节数截断且不切坏多字节字符。直接 slice(length) 会把 CJK 的
// 3 字节序列切成乱码，模型看到的是替换字符而不是指令；二分找最后一个不超限的
// 字符边界，代价是 O(log n) 次编码，只在上限被击穿时走一次。
const truncateToBytes = (text: string, limit: number) => {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= limit) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (encoder.encode(text.slice(0, mid)).byteLength <= limit) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}

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

export class Service extends Context.Service<Service, Interface>()("@redcode/Instruction") {}

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
      const config = yield* cfg.get()
      const timeout = config.instruction_budget?.fetch_timeout_ms ?? DEFAULT_INSTRUCTION_BUDGET.fetchTimeoutMs
      // 260913 Red timeout 必须罩住响应体读取：原实现只包 execute，慢速吐 body 的服务器
      // 会让这一轮 system prompt 组装无界挂住（没有上限就是缺陷）。
      return yield* Effect.gen(function* () {
        const res = yield* http.execute(HttpClientRequest.get(url))
        const body = yield* res.arrayBuffer
        return new TextDecoder().decode(body)
      }).pipe(
        Effect.timeout(timeout),
        Effect.catch(() => Effect.succeed("")),
      )
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
          const projectMemory = path.join(projectRoot(ctx), ".redcode", "MEMORY.md")
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
      const maxSourceBytes = config.instruction_budget?.max_source_bytes ?? DEFAULT_INSTRUCTION_BUDGET.maxSourceBytes
      const maxTotalBytes = config.instruction_budget?.max_total_bytes ?? DEFAULT_INSTRUCTION_BUDGET.maxTotalBytes
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      // 260913 Red 单来源硬上限：超限整份跳过，既不注入半截指令，也不无声吞掉。
      // 上限可配置（instruction_budget.max_source_bytes），默认 1MiB 足够宽松。
      const skipped: string[] = []
      const sources = [
        ...Array.from(paths).flatMap((item, i) => {
          const content = files[i]
          if (!content) return []
          if (bytes(content) > maxSourceBytes) {
            skipped.push(`${bytes(content)} bytes: ${item}`)
            return []
          }
          return [{ source: item, text: `Instructions from: ${item}\n${content}` }]
        }),
        ...urls.flatMap((item, i) => {
          const content = remote[i]
          if (!content) return []
          if (bytes(content) > maxSourceBytes) {
            skipped.push(`${bytes(content)} bytes: ${item}`)
            return []
          }
          return [{ source: item, text: `Instructions from: ${item}\n${content}` }]
        }),
      ]
      for (const item of skipped) {
        Log.Default.warn(
          `Instruction source skipped, over instruction_budget.max_source_bytes (${maxSourceBytes}): ${item}`,
        )
      }

      // 260929 Red 总量从「只告警」改为执行。260813 刻意不截断，理由是截断会丢指令
      // （漏掉铁律比前缀长更糟）——那个判断没错，错的是把「不截断」执行成了「不设防」：
      // 本机五份注入实测合计 56.4KiB / 预算 64KiB，已用 88%，越线后除了日志什么都没发生，
      // 前缀继续涨。「有上限」退化成了「有告警」。
      // 现在按优先级从尾部整份丢弃来源（sources 的顺序即 systemPaths 的注入顺序：
      // 全局 AGENTS → 项目 AGENTS → 全局 MEMORY → 项目 MEMORY → soul → config instructions），
      // 绝不切半截文件——那正是 260813 要避免的静默丢铁律。被丢的来源进模型可见声明行，
      // 模型知道指令不完整；只剩一个来源仍超限时才截断它本身并带显式标记，
      // 保证输出字节有确定上界（maxTotalBytes + 标记行）。
      let total = sources.reduce((sum, s) => sum + bytes(s.text), 0)
      const dropped: string[] = []
      while (sources.length > 1 && total > maxTotalBytes) {
        const removed = sources.pop()!
        total -= bytes(removed.text)
        dropped.push(removed.source)
      }
      if (dropped.length > 0) {
        Log.Default.warn(
          `Instruction sources dropped, over instruction_budget.max_total_bytes (${maxTotalBytes}): ${dropped.join(", ")}`,
        )
      }
      if (sources.length === 1 && total > maxTotalBytes) {
        const only = sources[0]
        only.text = `${truncateToBytes(only.text, maxTotalBytes)}\n[instruction budget] truncated at ${maxTotalBytes} bytes (instruction_budget.max_total_bytes); the tail of ${only.source} was cut. Raise the limit in config if a rule you need is missing.`
        total = bytes(only.text)
        Log.Default.warn(
          `Instruction source truncated to instruction_budget.max_total_bytes (${maxTotalBytes}): ${only.source}`,
        )
      }

     // 260929 Red 显式优先级声明。没有这句时，用户自己写的 AGENTS.md 与引擎默认提示词
     // 冲突，谁赢全靠模型自己猜；放在所有来源之前，位置稳定、不随后续增删而移动。
     // 没有任何来源时不输出——没有"下面的指令"时这句话是纯噪音，还白占 token。
     const parts = [
       ...(sources.length > 0 ? ["The instructions below OVERRIDE any default behavior when they conflict."] : []),
       ...sources.map((s) => s.text),
     ]
      if (dropped.length > 0) {
        parts.push(
          `[instruction budget] ${dropped.length} instruction source(s) dropped for exceeding instruction_budget.max_total_bytes (${maxTotalBytes}): ${dropped.join(", ")}. Their rules are absent from this session - raise the limit in config if one of them matters.`,
        )
      }
      return parts
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
      const config = yield* cfg.get()
      const maxSourceBytes = config.instruction_budget?.max_source_bytes ?? DEFAULT_INSTRUCTION_BUDGET.maxSourceBytes
      const maxResolvedBytes =
        config.instruction_budget?.max_resolved_bytes ?? DEFAULT_INSTRUCTION_BUDGET.maxResolvedBytes
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      let resolvedBytes = 0
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
        if (content && bytes(content) > maxSourceBytes) {
          Log.Default.warn(
            `Nearby instruction skipped, over instruction_budget.max_source_bytes (${maxSourceBytes}): ${bytes(content)} bytes: ${found}`,
          )
        } else if (content) {
          const formatted = `Instructions from: ${found}\n${content}`
          const size = bytes(formatted)
          if (resolvedBytes + size > maxResolvedBytes) {
            Log.Default.warn(
              `Nearby instruction skipped, over instruction_budget.max_resolved_bytes (${maxResolvedBytes}): ${size} bytes: ${found}`,
            )
          } else {
            resolvedBytes += size
            results.push({ filepath: found, content: formatted })
          }
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
