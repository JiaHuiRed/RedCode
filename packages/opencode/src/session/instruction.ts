import path from "path"
import { Effect, Layer, Context, Option, Schema, Stream } from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/http"
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

// 260929 Red 保留优先级与注入顺序是两个维度。顺序决定输出（也决定前缀缓存从哪里断），
// 优先级决定超预算时谁先被丢。Soul 已独立于 Instruction 管理，不参与此来源预算。
//
// 优先级按「模型要正确干活，最不能少的是什么」排：
//   0 AGENTS.md（全局/项目）——硬规则，漏一条可能直接违反映该不该做某件事
//   1 MEMORY.md（全局/项目）——教训索引，丢了少一些触发提醒，全文在召回库可查
//   2 config.instructions——用户显式配置的额外指令，丢了可在配置里复看
const RETENTION = { agents: 0, memory: 1, config: 2 } as const
type SourceKind = keyof typeof RETENTION

// 261107 Red 注入清单的对外形状：describe() 返回、/instructions HTTP 面与 TUI 对话框
// 共用。只描述「谁被注入、各占多少、谁被预算丢了」，不携带内容本身——内容进上下文有
// 四问约束，清单是给人看的观测面。
export const SourceInfo = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["agents", "memory", "config"]),
  bytes: Schema.Number,
  status: Schema.Literals(["injected", "skipped", "dropped", "truncated", "missing", "empty"]),
  // 注入/被丢/被截断时的最终格式化字节（含 "Instructions from:" 前缀）；missing/empty 无。
  effectiveBytes: Schema.optional(Schema.Number),
}).annotate({ identifier: "InstructionSource" })

export const Inventory = Schema.Struct({
  sources: Schema.Array(SourceInfo),
  totalBytes: Schema.Number,
  budget: Schema.Struct({
    maxSourceBytes: Schema.Number,
    maxTotalBytes: Schema.Number,
  }),
}).annotate({ identifier: "InstructionInventory" })
export type Inventory = Schema.Schema.Type<typeof Inventory>

// 260929 Red 声明行自己也要有硬上限。dropped 的来源名可能来自 config.instructions，
// 而那是 Schema.Array(String)、没有长度上限——一条足够长的 glob 就能让声明行本身
// 突破 maxTotalBytes。上一轮我写「输出 ≤ maxTotalBytes + 有界标记行」，那句是过度
// 乐观：标记行当时一个字节的上界都没有。
// 上界由列举阶段保证：列满 MARKER_ITEMS 条或吃满字节额度就停，其余折叠成计数。
// 前缀/后缀只随 maxTotalBytes 的数字变长，512 字节对它们是 2.5 倍余量。
const MAX_BUDGET_MARKER_BYTES = 2048
const MARKER_ITEMS = 8
const MARKER_RESERVE = 512
const CUT_MARKER = "[…]"

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

// 260929 Red 声明行与日志共用的来源列举：列满 MARKER_ITEMS 条或吃满字节额度就停，
// 其余折叠成计数。日志侧同样要收——来源名可以任意长，无界列举既是日志噪音也是注入面的影子。
const budgetList = (items: string[], maxBytes: number) => {
  const shown: string[] = []
  let used = 0
  for (const item of items) {
    if (shown.length >= MARKER_ITEMS) break
    const size = bytes(item) + 2
    if (used + size > maxBytes) break
    shown.push(item)
    used += size
  }
  const rest = items.length - shown.length
  return shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "")
}

const files = (disableClaudeCodePrompt: boolean) => [
  "AGENTS.md",
  ...(disableClaudeCodePrompt ? [] : ["CLAUDE.md"]),
  "CONTEXT.md", // deprecated
]

// 261109 Karina RC-01 指令注入的路径边界。原实现用字符串前缀（current.startsWith(root)）
// 判断「在项目目录之下」：root 是 C:\work\RedCode 时，兄弟目录 C:\work\RedCode-backup
// 前缀相同会被判成项目内，读外部文件时把别的项目的 AGENTS.md 当本项目指令注入。
// 改用 path.relative 语义（AppFileSystem.contains 已处理跨盘符、UNC 与大小写差异），
// 再按真实路径判一次——find() 走逻辑路径、读的是链接目标，项目内的目录联接可以指向
// 根之外。语义：严格位于根之下，不含根目录自身（根目录的指令由 system() 注入）。
// See docs/notes/implemented/bug-fix/2026-11-09-instruction-path-boundary-and-remote-cap.md.
export const isWithinRoot = (root: string, candidate: string) => {
  if (!AppFileSystem.contains(root, candidate) || path.relative(root, candidate) === "") return false
  try {
    return AppFileSystem.contains(AppFileSystem.resolve(root), AppFileSystem.resolve(candidate))
  } catch {
    // realpath 失败（权限、并发删除）时退回逻辑路径判定：链接逃逸是加固项，
    // 不能因为解析不出真实路径，连项目内的正常指令一起丢掉。
    return true
  }
}

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
  readonly describe: () => Effect.Effect<Inventory, AppFileSystem.Error>
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

    // 261109 Karina RC-01 远程指令改成流式读取。原实现 res.arrayBuffer 先把整个响应体
    // 载入内存，字节预算只在解码后才检查——恶意或异常来源能让内存随响应体大小线性增长，
    // chunked 响应也没有 Content-Length 兜底。现在逐块累计原始字节，超过
    // instruction_budget.max_source_bytes 立刻停止读取（取消响应流）并整份丢弃，
    // 不注入半截内容。Content-Length 只用于提前拒绝：服务器可以撒谎或缺失，
    // 不能代替实际读取字节计数。
    // See docs/notes/implemented/bug-fix/2026-11-09-instruction-path-boundary-and-remote-cap.md.
    const fetch = Effect.fnUntraced(function* (url: string) {
      const config = yield* cfg.get()
      const timeout = config.instruction_budget?.fetch_timeout_ms ?? DEFAULT_INSTRUCTION_BUDGET.fetchTimeoutMs
      const maxBytes = config.instruction_budget?.max_source_bytes ?? DEFAULT_INSTRUCTION_BUDGET.maxSourceBytes
      // 日志只留协议 + 主机 + 路径：查询串可能携带访问令牌，不能原样进日志。
      const label = (() => {
        try {
          const parsed = new URL(url)
          return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
        } catch {
          // 配置层已校验过 URL 形状，这里只兜畸形输入；不回显原文以免泄漏
          return "(invalid url)"
        }
      })()
      const read = Effect.gen(function* () {
        const res = yield* http.execute(HttpClientRequest.get(url))
        const declared = Option.getOrUndefined(Headers.get(res.headers, "content-length"))
        if (declared !== undefined && Number(declared) > maxBytes) {
          Log.Default.warn(
            `Instruction source skipped, Content-Length ${declared} over instruction_budget.max_source_bytes (${maxBytes}): ${label}`,
          )
          return ""
        }
        const chunks: Uint8Array[] = []
        let total = 0
        let overflow = false
        yield* res.stream.pipe(
          Stream.runForEachWhile((chunk) =>
            Effect.sync(() => {
              if (total + chunk.byteLength > maxBytes) {
                overflow = true
                return false
              }
              chunks.push(chunk)
              total += chunk.byteLength
              return true
            }),
          ),
        )
        if (overflow) {
          Log.Default.warn(
            `Instruction source skipped, response over instruction_budget.max_source_bytes (${maxBytes}): ${label}`,
          )
          return ""
        }
        const body = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          body.set(chunk, offset)
          offset += chunk.byteLength
        }
        return new TextDecoder().decode(body)
      })
      // 260913 Red timeout 必须罩住响应体读取：原实现只包 execute，慢速吐 body 的服务器
      // 会让这一轮 system prompt 组装无界挂住（没有上限就是缺陷）。超时、网络异常、
      // 超限都安全失败，不注入半截远程指令。
      return yield* read.pipe(
        Effect.timeout(timeout),
        Effect.catch((error) => {
          Log.Default.warn(`Instruction source fetch failed: ${label} (${error._tag})`)
          return Effect.succeed("")
        }),
      )
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    // 260929 Red 唯一的发现实现，两个投影：systemPaths() 只要路径集合（给 resolve 判重），
    // system() 要路径 + 保留优先级（超预算时决定丢谁）。原来是同一个函数只返回 Set，
    // 优先级无处安放；按路径字符串反推类别又脆又容易和发现逻辑漂移。
    const discover = Effect.fnUntraced(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const found: { path: string; kind: SourceKind }[] = []
      const add = (file: string, kind: SourceKind) => {
        const resolved = path.resolve(file)
        // 同一路径只留第一次出现——与原来 Set 的去重语义一致
        if (found.some((item) => item.path === resolved)) return
        found.push({ path: resolved, kind })
      }

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          add(file, "agents")
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
            matches.forEach((item) => add(item, "agents"))
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
        if (yield* fs.existsSafe(globalMemory)) add(globalMemory, "memory")

        if (!Flag.REDCODE_DISABLE_PROJECT_CONFIG) {
          // 260729 Red 不能直接用 ctx.worktree —— 目录不是 git 仓库时它是文件系统根 "/"，
          // path.join("/", ".redcode", "MEMORY.md") 会算成 <当前盘>:\.redcode\MEMORY.md。
          // 后果是双向的：读会去盘符根读，写也会写到盘符根。本机 C:/D:/E: 三个盘根下都留着
          // 一整套被 scaffold 出来的 .redcode/（MEMORY.md + .gitignore + package.json +
          // node_modules），就是这么来的。非 git 项目退回 ctx.directory 作为项目根。
          const projectMemory = path.join(projectRoot(ctx), ".redcode", "MEMORY.md")
          if (yield* fs.existsSafe(projectMemory)) add(projectMemory, "memory")
        }
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
          matches.forEach((item) => add(item, "config"))
        }
      }

      return found
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const found = yield* discover()
      return new Set(found.map((item) => item.path))
    })

    // 261107 Red 预算管线只有一份：system()（注入文本，每轮热路径）与 describe()（注入
    // 清单，给 /instructions 与 HTTP 面）共用 evaluate()，防止两处各自演算预算语义后漂移。
    // evaluate 返回的 parts 与抽取前 system() 逐字节一致；report 是各来源命运的投影。
    const evaluate = Effect.fn("Instruction.evaluate")(function* () {
      const config = yield* cfg.get()
      const maxSourceBytes = config.instruction_budget?.max_source_bytes ?? DEFAULT_INSTRUCTION_BUDGET.maxSourceBytes
      const maxTotalBytes = config.instruction_budget?.max_total_bytes ?? DEFAULT_INSTRUCTION_BUDGET.maxTotalBytes
      const discovered = yield* discover()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(
        discovered.map((item) => item.path),
        read,
        { concurrency: 8 },
      )
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      // 260913 Red 单来源硬上限：超限整份跳过，既不注入半截指令，也不无声吞掉。
      // 上限可配置（instruction_budget.max_source_bytes），默认 1MiB 足够宽松。
      const skipped: string[] = []
      // 261107 Red 每个发现来源的命运：skipped（单源超限）/ dropped（总量超限）/
      // truncated（独苗截断）/ missing（发现时存在、读取时消失）/ empty（零字节）。
      // describe() 原样上报；system() 不消费。
      type Entry = {
        source: string
        kind: SourceKind
        order: number
        priority: number
        rawBytes: number
        text?: string
        status: "injected" | "skipped" | "dropped" | "truncated" | "missing" | "empty"
      }
      const entries: Entry[] = [
        ...discovered.flatMap((item, i): Entry[] => {
          const content = files[i]
          const entry: Entry = {
            source: item.path,
            kind: item.kind,
            order: i,
            priority: RETENTION[item.kind],
            rawBytes: content ? bytes(content) : 0,
            status: content === undefined ? "missing" : "empty",
          }
          if (!content) return [entry]
          if (bytes(content) > maxSourceBytes) {
            skipped.push(`${bytes(content)} bytes: ${item.path}`)
            entry.status = "skipped"
            return [entry]
          }
          entry.text = `Instructions from: ${item.path}\n${content}`
          entry.status = "injected"
          return [entry]
        }),
        ...urls.flatMap((item, i): Entry[] => {
          const content = remote[i]
          const entry: Entry = {
            source: item,
            kind: "config",
            order: discovered.length + i,
            priority: RETENTION.config,
            rawBytes: content ? bytes(content) : 0,
            status: content === undefined ? "missing" : "empty",
          }
          if (!content) return [entry]
          if (bytes(content) > maxSourceBytes) {
            skipped.push(`${bytes(content)} bytes: ${item}`)
            entry.status = "skipped"
            return [entry]
          }
          entry.text = `Instructions from: ${item}\n${content}`
          entry.status = "injected"
          return [entry]
        }),
      ]
      // order 是注入次序（决定输出与缓存断点），priority 是保留优先级（决定谁先被丢）。
      const sources = entries
        .filter((entry) => entry.status === "injected")
        .map((entry) => ({ source: entry.source, text: entry.text!, order: entry.order, priority: entry.priority, entry }))
      for (const item of skipped) {
        Log.Default.warn(
          `Instruction source skipped, over instruction_budget.max_source_bytes (${maxSourceBytes}): ${item}`,
        )
      }

      // 260929 Red 总量从「只告警」改为执行。260813 刻意不截断，理由是截断会丢指令
      // （漏掉铁律比前缀长更糟）——那个判断没错，错的是把「不截断」执行成了「不设防」：
      // 本机五份注入实测合计 56.4KiB / 预算 64KiB，已用 88%，越线后除了日志什么都没发生，
      // 前缀继续涨。「有上限」退化成了「有告警」。
      // 现在按 RETENTION 优先级整份丢弃来源，绝不切半截文件——那正是 260813 要避免的
      // 静默丢铁律。被丢的来源进模型可见声明行，模型知道指令不完整；只剩一个来源仍超限时
      // 才截断它本身并带显式标记，保证输出字节有确定上界。
      let total = sources.reduce((sum, s) => sum + bytes(s.text), 0)
      const dropped: string[] = []
      // 每轮丢当前最该丢的那一份：priority 大的先丢，并列时丢 order 大的（让靠前的
      // 已缓存前缀尽量不动）。splice 保序，所以循环结束后 sources 仍是注入顺序。
      while (sources.length > 1 && total > maxTotalBytes) {
        let worst = 0
        for (let i = 1; i < sources.length; i++) {
          const candidate = sources[i]
          const current = sources[worst]
          if (
            candidate.priority > current.priority ||
            (candidate.priority === current.priority && candidate.order > current.order)
          ) {
            worst = i
          }
        }
        const removed = sources.splice(worst, 1)[0]
        removed.entry.status = "dropped"
        total -= bytes(removed.text)
        dropped.push(removed.source)
      }
      if (dropped.length > 0) {
        Log.Default.warn(
          `Instruction sources dropped, over instruction_budget.max_total_bytes (${maxTotalBytes}): ${budgetList(dropped, Number.MAX_SAFE_INTEGER)}`,
        )
      }
      if (sources.length === 1 && total > maxTotalBytes) {
        const only = sources[0]
        only.text = `${truncateToBytes(only.text, maxTotalBytes)}\n[instruction budget] truncated at ${maxTotalBytes} bytes (instruction_budget.max_total_bytes); the tail of ${only.source} was cut. Raise the limit in config if a rule you need is missing.`
        total = bytes(only.text)
        only.entry.status = "truncated"
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
        const list = budgetList(dropped, MAX_BUDGET_MARKER_BYTES - MARKER_RESERVE)
        const marker =
          `[instruction budget] ${dropped.length} instruction source(s) dropped for exceeding instruction_budget.max_total_bytes (${maxTotalBytes}): ${list}` +
          `. Their rules are absent from this session - raise the limit in config if one of them matters.`
        // 兜底：正常情况下列举阶段已经把它收进 2048 内，走不到这里。留着是防有人把
        // 前缀/后缀写长——那时宁可截断带省略标记，也不能让声明行突破上界。
        const capped = truncateToBytes(marker, MAX_BUDGET_MARKER_BYTES - CUT_MARKER.length)
        parts.push(capped === marker ? marker : capped + CUT_MARKER)
      }
      const report = entries.map((entry) => ({
        path: entry.source,
        kind: entry.kind,
        bytes: entry.rawBytes,
        status: entry.status,
        ...(entry.text !== undefined ? { effectiveBytes: bytes(entry.text) } : {}),
      }))
      return { parts, report, total, maxSourceBytes, maxTotalBytes }
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const { parts } = yield* evaluate()
      return parts
    })

    // 261107 Red 注入清单：谁被注入、各占多少字节、谁被预算丢弃。只给用户/HTTP 面，
    // 不进模型上下文。
    const describe = Effect.fn("Instruction.describe")(function* () {
      const { report, total, maxSourceBytes, maxTotalBytes } = yield* evaluate()
      return { sources: report, totalBytes: total, budget: { maxSourceBytes, maxTotalBytes } }
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
      while (isWithinRoot(root, current)) {
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

    return Service.of({ clear, systemPaths, system, describe, find, resolve })
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
