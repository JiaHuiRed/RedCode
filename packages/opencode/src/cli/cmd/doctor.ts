import { Cause, Effect, Exit } from "effect"
import { generateText } from "ai"
import { effectCmd, fail } from "../effect-cmd"
import { Config } from "@/config/config"
import { ConfigRetire } from "@/config/retire"
import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { MCP } from "@/mcp"
import { ModelsDev } from "@redcode-ai/core/models-dev"
import { Global } from "@redcode-ai/core/global"
import { Installation } from "@/installation"
import { InstallationVersion } from "@redcode-ai/core/installation/version"
import * as Console from "effect/Console"
import * as fs from "node:fs"
import path from "node:path"
import { errorMessage } from "@/util/error"
import { Soul } from "@/soul"
import { MAX_SOUL_BYTES } from "@/soul/schema"
import { MAX_SOUL_PROMPT_BYTES, render } from "@/session/soul"
import { resolveDefaultSoul } from "@/session/session"

type Status = "ok" | "warn" | "error" | "skip"

interface Check {
  name: string
  status: Status
  detail: string
}

interface Group {
  name: string
  checks: Check[]
}

// 组级状态取组内最坏的一条。skip 排在 ok 之后、warn 之前：它不是故障，但也不是
// “查过了没问题”，必须和真正通过的检查区分开。
const RANK: Record<Status, number> = { ok: 0, skip: 1, warn: 2, error: 3 }

function groupStatus(checks: Check[]): Status {
  return checks.reduce<Status>((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), "ok")
}

const ICON: Record<Status, string> = { ok: "✓", warn: "!", error: "✗", skip: "-" }

/**
 * 261021 Red 审计 RC21-01：退役键迁移在配置加载时自动跑，这条只兜「写盘失败」与「又被写回」
 * 的残留。只报键名与来源，不碰配置值 —— doctor 的输出经常被整段贴进 issue。
 */
function retiredCheck(worktree: string): Check {
  const files = [
    path.join(Global.Path.config, "redcode.jsonc"),
    path.join(Global.Path.config, "redcode.json"),
    path.join(Global.Path.config, "redcode.local.jsonc"),
    path.join(Global.Path.config, "redcode.local.json"),
    path.join(worktree, "redcode.jsonc"),
    path.join(worktree, "redcode.json"),
    path.join(worktree, ".redcode", "redcode.jsonc"),
    path.join(worktree, ".redcode", "redcode.local.jsonc"),
  ]
  const hits = files.flatMap((file) => {
    if (!fs.existsSync(file)) return []
    const keys = ConfigRetire.scanText(fs.readFileSync(file, "utf8"))
    if (!keys.length) return []
    const source = file.startsWith(worktree)
      ? path.relative(worktree, file).replaceAll("\\", "/")
      : `global/${path.basename(file)}`
    return [`${source}: ${keys.join(", ")}`]
  })
  if (!hits.length) return { name: "config-retired", status: "ok", detail: "no retired keys" }
  return {
    name: "config-retired",
    status: "warn",
    detail: `${hits.join("; ")} — remove them or make the file writable, then restart`,
  }
}

/**
 * 把一个可能失败的 Effect 收成一条 Check。
 *
 * 260821 cc：这里原来是 try { yield* ... } catch，四处（config / providers /
 * plugins / mcp）都是。那是**无效**的 —— Effect 的失败走错误通道，不会变成 JS
 * 异常。实测 yield* Effect.fail(...) 与 yield* Effect.sync(() => { throw }) 都
 * 不进 catch 块，只有生成器体里的纯 JS throw 会。
 *
 * 后果是反的：代码看起来实现了优雅降级，实际上任何一个检查失败会直接杀掉整条
 * 诊断，一条结果都拿不到 —— 而 doctor 恰恰是“东西坏了才跑”的命令，最需要它在
 * 部分失败时还能报出其余部分。所以必须用 Effect.exit 显式接住。
 */
function attempt<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  onSuccess: (value: A) => Check,
): Effect.Effect<Check, never, R> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return onSuccess(exit.value)
    return { name, status: "error", detail: errorMessage(Cause.squash(exit.cause)) }
  })
}

/** 依赖项没就位时，被跳过的检查要显式留在输出里 —— 静默消失比报错更难查。 */
function skipped(names: string[], why: string): Check[] {
  return names.map((name) => ({ name, status: "skip" as const, detail: why }))
}

const NO_CONFIG = "skipped: config not loaded"

export function soulRegistryCheck(valid: number, issues: number): Check {
  return {
    name: "registry",
    status: issues ? "warn" : "ok",
    detail: `${valid} valid Soul(s), ${issues} issue(s)`,
  }
}

export function soulBudgetCheck(file: string, bytes: number): Check {
  return {
    name: "soul-source",
    status: bytes > MAX_SOUL_BYTES ? "warn" : "ok",
    detail: `${bytes} B of ${MAX_SOUL_BYTES} B source limit · ${file}`,
  }
}

export function soulRenderCheck(bytes: number): Check {
  return {
    name: "soul-render",
    status: bytes > MAX_SOUL_PROMPT_BYTES ? "warn" : "ok",
    detail: `${bytes} B of ${MAX_SOUL_PROMPT_BYTES} B rendered Soul limit · excluded from instruction budget`,
  }
}

// ---- probe（261109 Karina RC-04 收口：真实模型/MCP 连通性探测）----
// 显式 opt-in 靠 --probe 本身；限次 = 最多 3 家 × 每家 1 次最小请求，无重试；
// 费用提示在 --help describe 与 human 模式的开场行里（JSON 模式 stdout 必须纯净）。
// 决策记录：docs/notes/implemented/feature/2026-11-09-doctor-probe.md

export const PROBE_MAX_PROVIDERS = 3

// 261109 Karina 泛型保留 ProviderID 的品牌类型 —— 返回值还要拿去索引 Record<ProviderID, Info>。
export function selectProbeProviders<T>(ids: T[], opts: { defaultProviderID?: T; max: number }): T[] {
  const ordered =
    opts.defaultProviderID !== undefined && ids.includes(opts.defaultProviderID)
      ? [opts.defaultProviderID, ...ids.filter((id) => id !== opts.defaultProviderID)]
      : ids
  return ordered.slice(0, opts.max)
}

// 261109 Karina 模型探测结果 → Check。失败 detail 走 errorMessage（只留 message，不带 key）。
export function probeModelCheck(providerID: string, result: { modelID: string; ms: number } | { error: unknown }): Check {
  if ("error" in result) {
    return { name: `model:${providerID}`, status: "error", detail: errorMessage(result.error) }
  }
  return {
    name: `model:${providerID}`,
    status: "ok",
    detail: `ok via ${result.modelID} in ${result.ms}ms`,
  }
}

// 261109 Karina MCP 状态映射。probe 不自建连接：MCP 层在 AppRuntime 初始化时就已
// forkScoped(connectAll) 后台连接，这里只观察 status() 收敛到终态的结果。
// waiting 超时后仍停在 connecting 的 server 连 failed 都不是 —— 挂起比失败更难查，单独报 error。
export function probeMcpChecks(statuses: Record<string, MCP.Status>): Check[] {
  const entries = Object.entries(statuses)
  if (!entries.length) return [{ name: "mcp", status: "skip", detail: "no servers configured" }]
  return entries.map(([name, value]): Check => {
    switch (value.status) {
      case "connected":
        return { name: `mcp:${name}`, status: "ok", detail: "connected" }
      case "disabled":
        return { name: `mcp:${name}`, status: "skip", detail: "disabled in config" }
      case "connecting":
        return { name: `mcp:${name}`, status: "error", detail: "still connecting after probe deadline" }
      case "needs_auth":
        return { name: `mcp:${name}`, status: "warn", detail: "needs authentication" }
      case "needs_client_registration":
        return { name: `mcp:${name}`, status: "warn", detail: value.error }
      case "deferred":
        // 261111 Karina 懒启动：故意的等待态，既不是挂起也不是失败
        return { name: `mcp:${name}`, status: "skip", detail: "deferred (starts on first use)" }
      case "failed":
        return { name: `mcp:${name}`, status: "error", detail: value.error }
    }
  })
}

// 261109 Karina probe 组体：模型探测串行执行（限次的另一面 —— 同时也不会并发压同一个上游），
// 单家失败收成 error check 不影响其余家；MCP 只等后台连接收敛，零成本。
const PROBE_DEADLINE_MS = 15_000
const probeGroup = Effect.fn("Cli.doctor.probeGroup")(function* (cfg: Config.Info | undefined) {
  if (!cfg) return { name: "probe", checks: skipped(["model", "mcp"], NO_CONFIG) }

  const modelExit = yield* Effect.exit(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const list = yield* provider.list()

      // 候选过滤与 providers 静态检查同口径（enabled/disabled）；凭据看合并后的 Info ——
      // env/auth 进 key，config 进 options.apiKey，只看 Auth 会漏掉 config 型 key。
      const enabledProviders = cfg.enabled_providers ? new Set(cfg.enabled_providers) : undefined
      const disabledProviders = new Set(cfg.disabled_providers ?? [])
      const credentialed = Object.values(list).filter(
        (info) =>
          (enabledProviders ? enabledProviders.has(info.id) : true) &&
          !disabledProviders.has(info.id) &&
          (info.key !== undefined || typeof info.options?.apiKey === "string"),
      )
      if (!credentialed.length)
        return [{ name: "model", status: "skip" as const, detail: "no credentialed providers" }]

      const defaultExit = yield* Effect.exit(provider.defaultModel())
      const selected = selectProbeProviders(credentialed.map((info) => info.id), {
        defaultProviderID: Exit.isSuccess(defaultExit) ? defaultExit.value.providerID : undefined,
        max: PROBE_MAX_PROVIDERS,
      })

      return yield* Effect.forEach(
        selected,
        (id) =>
          Effect.gen(function* () {
            // getSmallModel 挑最便宜的模型做探测，把探测成本压到最低；没有就退第一家模型。
            const small = yield* Effect.exit(provider.getSmallModel(id))
            const model = Exit.isSuccess(small) ? small.value : undefined
            const target = model ?? Object.values(list[id].models)[0]
            if (!target) return probeModelCheck(id, { error: new Error("no model available") })

            const language = yield* provider.getLanguage(target)
            // abortSignal 让底层 fetch 真正中断；Effect.timeout 是兜底 —— 防 SDK 忽略
            // abortSignal 时把诊断进程无限挂住（无界等待在日志里一个字都不会留）。
            const start = Date.now()
            yield* Effect.promise(() =>
              generateText({
                model: language,
                messages: [{ role: "user", content: "ping" }],
                abortSignal: AbortSignal.timeout(PROBE_DEADLINE_MS),
              }),
            ).pipe(Effect.timeout("20 seconds"))
            return probeModelCheck(id, { modelID: target.id, ms: Date.now() - start })
          }).pipe(
            Effect.exit,
            Effect.map((exit) =>
              Exit.isSuccess(exit) ? exit.value : probeModelCheck(id, { error: Cause.squash(exit.cause) }),
            ),
          ),
        { concurrency: 1 },
      )
    }),
  )

  const mcpExit = yield* Effect.exit(
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      let statuses = yield* mcp.status()
      const deadline = Date.now() + PROBE_DEADLINE_MS
      while (Object.values(statuses).some((s) => s.status === "connecting") && Date.now() < deadline) {
        yield* Effect.sleep("500 millis")
        statuses = yield* mcp.status()
      }
      return probeMcpChecks(statuses)
    }),
  )

  return {
    name: "probe",
    checks: [
      ...(Exit.isSuccess(modelExit)
        ? modelExit.value
        : [{ name: "model", status: "error" as const, detail: errorMessage(Cause.squash(modelExit.cause)) }]),
      ...(Exit.isSuccess(mcpExit)
        ? mcpExit.value
        : [{ name: "mcp", status: "error" as const, detail: errorMessage(Cause.squash(mcpExit.cause)) }]),
    ],
  }
})

export const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "run diagnostics",
  builder: (yargs) =>
    yargs
      .option("json", {
        describe: "output as json",
        type: "boolean",
      })
      .option("prefix", {
        describe: "inspect the fixed prompt-prefix sources and their budget",
        type: "boolean",
      })
      .option("probe", {
        describe: `probe real model and MCP connectivity (up to ${PROBE_MAX_PROVIDERS} real API requests; may incur cost)`,
        type: "boolean",
      }),
  // Diagnostics should work without a full project instance; avoids bootstrap hang.
  instance: false,
  handler: Effect.fn("Cli.doctor")(function* (args) {
    const worktree = process.cwd()
    const groups: Group[] = []

    // ---- runtime ----
    const dbPath = path.join(Global.Path.data, "redcode.db")
    const dbExists = fs.existsSync(dbPath)
    groups.push({
      name: "runtime",
      checks: [
        {
          name: "version",
          status: "ok",
          // InstallationVersion 在本地构建里本身就是 "local"，再追加一次会打印成
          // "local (local)"。只在两者不同时才加后缀。
          detail:
            Installation.isLocal() && InstallationVersion !== "local"
              ? `${InstallationVersion} (local)`
              : InstallationVersion,
        },
        {
          name: "database",
          status: dbExists ? "ok" : "warn",
          detail: dbExists ? "exists" : "not found (will be created on first run)",
        },
      ],
    })

    const soulRegistry = yield* attempt(
      "registry",
      Effect.gen(function* () {
        const soul = yield* Soul.Service
        return { items: yield* soul.list(), issues: yield* soul.issues() }
      }).pipe(Effect.provide(Soul.defaultLayer)),
      (result) => soulRegistryCheck(result.items.length, result.issues.length),
    )
    const soulBudget = yield* attempt(
      "soul-budget",
      Effect.gen(function* () {
        const soul = yield* Soul.Service
        const client = process.env.REDCODE_CLIENT === "desktop" ? "desktop" : "tui"
        const id = yield* resolveDefaultSoul(soul, client)
        return { id, value: id ? yield* soul.get(id) : undefined }
      }).pipe(Effect.provide(Soul.defaultLayer)),
      ({ id, value }) => {
        if (!value)
          return {
            name: "soul-source",
            status: "warn",
            detail: id ? `default Soul "${id}" is unavailable` : "no client default Soul",
          }
        return soulBudgetCheck(value.path, fs.statSync(value.path).size)
      },
    )
    const soulRenderBudget = yield* attempt(
      "soul-render",
      Effect.gen(function* () {
        const soul = yield* Soul.Service
        const client = process.env.REDCODE_CLIENT === "desktop" ? "desktop" : "tui"
        const id = yield* resolveDefaultSoul(soul, client)
        return id ? yield* soul.get(id) : undefined
      }).pipe(Effect.provide(Soul.defaultLayer)),
      (value) =>
        value
          ? soulRenderCheck(Buffer.byteLength(render(value).prompt, "utf8"))
          : { name: "soul-render", status: "warn", detail: "no default Soul to render" },
    )
    groups.push({
      name: "souls",
      checks: [soulRegistry, soulBudget, soulRenderBudget],
    })

    // ---- config ----
    const configExit = yield* Effect.exit(
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.get()
      }),
    )
    const cfg = Exit.isSuccess(configExit) ? configExit.value : undefined

    const instructionFiles: string[] = []
    if (fs.existsSync(path.join(Global.Path.home, ".redcode", "MEMORY.md"))) {
      instructionFiles.push("global memory")
    }
    // 260805 Red 补 .redcode/ 与项目根的 AGENTS.md：原本只看 .opencode/，
    // 现在的项目多半根本没这个目录，诊断恒报 "no instruction files"
    if (
      fs.existsSync(path.join(worktree, "AGENTS.md")) ||
      fs.existsSync(path.join(worktree, ".redcode", "AGENTS.md")) ||
      fs.existsSync(path.join(worktree, ".opencode", "AGENTS.md"))
    ) {
      instructionFiles.push("AGENTS.md")
    }
    if (fs.existsSync(path.join(worktree, ".redcode", "MEMORY.md"))) {
      instructionFiles.push("project memory")
    }

    groups.push({
      name: "config",
      checks: [
        Exit.isSuccess(configExit)
          ? { name: "config", status: "ok", detail: "loaded" }
          : { name: "config", status: "error", detail: errorMessage(Cause.squash(configExit.cause)) },
        {
          name: "agents-md",
          status: instructionFiles.length > 0 ? "ok" : "warn",
          detail: instructionFiles.length > 0 ? instructionFiles.join(", ") : "no instruction files",
        },
        retiredCheck(worktree),
      ],
    })

    // ---- providers ----
    if (cfg) {
      const providers = yield* attempt(
        "providers",
        Effect.gen(function* () {
          const modelsDev = yield* ModelsDev.Service
          const database = yield* modelsDev.get()
          const auth = yield* Auth.Service
          const credentials = yield* auth.all()

          const enabledProviders = cfg.enabled_providers ? new Set(cfg.enabled_providers) : undefined
          const disabledProviders = new Set(cfg.disabled_providers ?? [])
          const allProviderIds = Object.keys(database)
          const enabled = allProviderIds.filter(
            (id) => (enabledProviders ? enabledProviders.has(id) : true) && !disabledProviders.has(id),
          )
          const disabled = allProviderIds.filter((id) => disabledProviders.has(id))
          const withAuth = enabled.filter((id) => credentials[id])
          const withoutAuth = enabled.filter((id) => !credentials[id])
          const models = enabled.reduce((sum, id) => sum + Object.keys(database[id].models ?? {}).length, 0)
          return { enabled, disabled, withAuth, withoutAuth, models }
        }),
        (r) => ({
          name: "providers",
          status: r.withoutAuth.length > 0 && r.enabled.length > 0 ? "warn" : "ok",
          detail: `${r.enabled.length} on, ${r.disabled.length} off, ${r.withAuth.length} auth, ${r.models} models`,
        }),
      )

      const plaintextKeys = Object.entries(cfg.provider ?? {}).filter(([, p]) => {
        const key = p.options?.apiKey
        return typeof key === "string" && key.length > 8 && key !== "public" && !key.startsWith("redcode-")
      })

      groups.push({
        name: "providers",
        checks: [
          providers,
          {
            name: "api-key-leak",
            status: plaintextKeys.length === 0 ? "ok" : "warn",
            detail:
              plaintextKeys.length === 0 ? "no plaintext keys" : `${plaintextKeys.length} plaintext key(s) in config`,
          },
        ],
      })
    } else {
      groups.push({ name: "providers", checks: skipped(["providers", "api-key-leak"], NO_CONFIG) })
    }

    // ---- extensions ----
    if (cfg) {
      const plugins = yield* attempt(
        "plugins",
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.list()
        }),
        (list) => ({ name: "plugins", status: "ok", detail: `${list.length} hooks loaded` }),
      )

      const countSkillsInDir = (dir: string): number => {
        if (!fs.existsSync(dir)) return 0
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        return entries.filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md"))).length
      }
      // 260805 Red 补 .redcode/skill(s)：配置发现链只认 .redcode，
      // 项目级技能装在那儿，原本一个都统计不到
      const projectSkills =
        countSkillsInDir(path.join(worktree, ".redcode", "skills")) +
        countSkillsInDir(path.join(worktree, ".redcode", "skill")) +
        countSkillsInDir(path.join(worktree, ".opencode", "skills")) +
        countSkillsInDir(path.join(worktree, ".opencode", "skill"))
      const globalSkills = countSkillsInDir(path.join(Global.Path.home, ".redcode", "skill"))
      const totalSkills = projectSkills + globalSkills

      const mcp = yield* attempt(
        "mcp",
        Effect.gen(function* () {
          const svc = yield* MCP.Service
          return yield* svc.status()
        }),
        (statuses) => {
          const connected = Object.values(statuses).filter((s) => s.status === "connected").length
          const total = Object.keys(statuses).length
          return {
            name: "mcp",
            status: total > 0 ? (connected === total ? "ok" : "warn") : "warn",
            detail: total > 0 ? `${connected}/${total} connected` : "no servers configured",
          }
        },
      )

      groups.push({
        name: "extensions",
        checks: [
          plugins,
          {
            name: "skill-coverage",
            status: totalSkills > 0 ? "ok" : "warn",
            detail: `${totalSkills} skills (${projectSkills} project, ${globalSkills} global)`,
          },
          mcp,
        ],
      })
    } else {
      groups.push({ name: "extensions", checks: skipped(["plugins", "skill-coverage", "mcp"], NO_CONFIG) })
    }

    // ---- probe（261109 Karina RC-04 收口：真实连通性，显式 opt-in）----
    if (args.probe) {
      // 费用提示只在 human 模式打印：--json 的 stdout 必须保持纯 JSON 可解析。
      // MCP 探测只是观察既有后台连接，不产生成本；成本上限来自模型探测（≤3 家 × 1 次）。
      if (!args.json) {
        yield* Console.log(
          `probe: real connectivity check — up to ${PROBE_MAX_PROVIDERS} model request(s), one minimal call each; may incur cost`,
        )
      }
      groups.push(yield* probeGroup(cfg))
    }

    // ---- prefix（261007 Red 固定前缀预算）----
    // 静态盘点各注入源的字节数与预算占比。清单与 session/instruction.ts 的发现链一致：
    // 全局 AGENTS → 项目 AGENTS → 全局 MEMORY → 项目 MEMORY → soul → config.instructions；
    // 不含远程 URL 与 read 附带的 nearby 指令。预算默认 64 KiB（instruction_budget.max_total_bytes 可覆盖）。
    if (args.prefix) {
      const home = Global.Path.home
      const DEFAULT_TOTAL = 64 * 1024
      const candidates: [string, string][] = [
        ["global-agents", path.join(home, ".redcode", "AGENTS.md")],
        ["project-agents", path.join(worktree, "AGENTS.md")],
        ["global-memory", path.join(home, ".redcode", "MEMORY.md")],
        ["project-memory", path.join(worktree, ".redcode", "MEMORY.md")],
        ...(cfg?.instructions ?? [])
          .filter((item) => !item.startsWith("https://") && !item.startsWith("http://"))
          .map((item): [string, string] => ["config", item]),
      ]
      const checked = candidates.map(([label, file]) => ({
        label,
        file,
        size: fs.existsSync(file) ? fs.statSync(file).size : undefined,
      }))
      const totalBytes = checked.reduce((sum, item) => sum + (item.size ?? 0), 0)
      const totalPct = Math.round((totalBytes / DEFAULT_TOTAL) * 100)
      const pct = (size: number) => Math.round((size / DEFAULT_TOTAL) * 100)
      groups.push({
        name: "prefix",
        checks: [
          ...checked.map((item): Check => ({
            name: item.label,
            status: item.size === undefined ? "skip" : "ok",
            detail:
              item.size === undefined
                ? `not found: ${item.file}`
                : `${item.size} B · ${pct(item.size)}% · ${item.file}`,
          })),
          {
            name: "total",
            status: totalBytes > DEFAULT_TOTAL || totalPct >= 90 ? "warn" : "ok",
            detail:
              totalBytes > DEFAULT_TOTAL
                ? `${totalBytes} B exceeds default budget ${DEFAULT_TOTAL} B — lowest priority dropped first: config → MEMORY → soul → AGENTS`
                : `${totalBytes} B · ${totalPct}% of default budget ${DEFAULT_TOTAL} B`,
          },
        ],
      })
    }

    const all = groups.flatMap((g) => g.checks)
    const tally = {
      ok: all.filter((c) => c.status === "ok").length,
      warn: all.filter((c) => c.status === "warn").length,
      error: all.filter((c) => c.status === "error").length,
      skip: all.filter((c) => c.status === "skip").length,
    }

    if (args.json) {
      yield* Console.log(
        JSON.stringify(
          { groups: groups.map((g) => ({ ...g, status: groupStatus(g.checks) })), tally, checks: all },
          null,
          2,
        ),
      )
    } else {
      // 框内可用宽度。边框按它生成，不再手写死一串 ─，改宽度时不会对不齐。
      const WIDTH = 56
      const bar = (l: string, r: string) => `${l}${"─".repeat(WIDTH)}${r}`
      const clamp = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`)

      // 左右两段之间永远至少留一个空格。原来的实现把 padding 压到 0 就直接粘死，
      // 真实输出里 providers 那行就是 "! providers190 enabled, ..."，读不出边界。
      // detail 可能是多行的 —— JSONC 解析错误会带上 "--- JSONC Input ---" 和原文，
      // 直接塞进表格会把框撑破（实测：config 报错那行把边框顶掉了两行）。表格里先把
      // 空白折成单空格再截断；--json 走的是另一条路，保留完整多行原文。
      const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
      // 左右各留一格边距、中间至少一格分隔，全部由 row 自己保证 —— 调用方不传
      // 补空格，否则 oneLine 的 trim 会把它吃掉，值直接贴到边框上。
      const row = (left: string, right: string) => {
        const l = clamp(left, WIDTH - 4)
        const r = clamp(oneLine(right), WIDTH - l.length - 3)
        return `│ ${l}${" ".repeat(WIDTH - 2 - l.length - r.length)}${r} │`
      }
      const center = (text: string) => {
        const t = clamp(text, WIDTH)
        const left = Math.floor((WIDTH - t.length) / 2)
        return `│${" ".repeat(left)}${t}${" ".repeat(WIDTH - left - t.length)}│`
      }

      yield* Console.log(bar("┌", "┐"))
      yield* Console.log(center("REDCODE DOCTOR"))
      for (const group of groups) {
        yield* Console.log(bar("├", "┤"))
        yield* Console.log(row(group.name, ICON[groupStatus(group.checks)]))
        for (const check of group.checks) {
          yield* Console.log(row(`  ${ICON[check.status]} ${check.name}`, check.detail))
        }
      }
      yield* Console.log(bar("├", "┤"))
      yield* Console.log(
        row(`${all.length} checks`, `${tally.ok} ok · ${tally.warn} warn · ${tally.error} error · ${tally.skip} skip`),
      )
      yield* Console.log(bar("└", "┘"))
    }

    // 退出码：只有 error 才算失败，warn 是提示。没有这一条的话
    // `redcode doctor && deploy` 完全没有保护 —— 之前无论多少 error 都返回 0。
    if (tally.error > 0) {
      yield* fail(`doctor found ${tally.error} error(s)`)
    }
  }),
})
