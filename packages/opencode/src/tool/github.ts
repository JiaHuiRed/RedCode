import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./github.md" with { type: "text" }

// 261024 Red GitHub 原生工具：薄封装已认证的 gh CLI（读侧），替代常关的官方 GitHub MCP。
//   设计边界：只读（无创建/修改面）、输出有界（四问第 4 条的逐面上限）、子进程显式超时。
export const Parameters = Schema.Struct({
  operation: Schema.Literals(["pr", "pr_reviews", "pr_checks", "pr_diff", "issue", "list"]).annotate({
    description:
      "pr (one PR's metadata + body), pr_reviews (review threads with inline comments at path:line), pr_checks (CI status), pr_diff (bounded patch), issue (issue + its comments), list (open PRs/issues)",
  }),
  number: Schema.optional(Schema.Number).annotate({
    description: "PR or issue number — required for pr / pr_reviews / pr_checks / pr_diff / issue",
  }),
  kind: Schema.optional(Schema.Literals(["pr", "issue"])).annotate({
    description: "list only: which kind to list (default pr)",
  }),
  state: Schema.optional(Schema.Literals(["open", "closed", "all"])).annotate({
    description: "list only: state filter (default open)",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "list only: max rows (default 20, max 50)",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

const GH_TIMEOUT_MS = 30_000
const BODY_MAX_CHARS = 4_000
const COMMENT_MAX_CHARS = 1_200
const COMMENT_MAX_COUNT = 30
const DIFF_MAX_BYTES = 50 * 1024

// 261024 Red 导出纯函数供单测：格式化/截断不带 IO，spawn 不进测试面（会碰真 gh）。
export function capText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} chars]`
}

export function capBytes(text: string, max: number): string {
  const bytes = Buffer.byteLength(text)
  if (bytes <= max) return text
  // 261024 Red 按字节截必须走 Buffer：slice 按字符数切，多字节文本（diff 注释含中文）
  //   切完仍可能超限——测试实证 40k 汉字 slice(0, max-64) 后仍是 3 倍字节。
  //   subarray 切在码点中间时 toString 产生一个替换符，后面紧跟截断标记，可接受。
  const cut = Buffer.from(text, "utf8").subarray(0, Math.max(0, max - 64)).toString("utf8")
  return `${cut}\n[... diff truncated at ${max} bytes of ${bytes}]`
}

export interface PrInfo {
  number: number
  title: string
  state: string
  isDraft?: boolean
  author?: { login?: string }
  baseRefName?: string
  headRefName?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  body?: string
  url?: string
}

export function formatPr(pr: PrInfo): string {
  const lines = [
    `#${pr.number} ${pr.title}${pr.isDraft ? " [draft]" : ""} (${pr.state})`,
    `by ${pr.author?.login ?? "unknown"} · ${pr.headRefName ?? "?"} → ${pr.baseRefName ?? "?"}` +
      (pr.changedFiles !== undefined ? ` · +${pr.additions ?? 0}/-${pr.deletions ?? 0} across ${pr.changedFiles} files` : ""),
    "",
    capText((pr.body ?? "").trim(), BODY_MAX_CHARS) || "(no description)",
  ]
  if (pr.url) lines.push("", pr.url)
  return lines.join("\n")
}

export interface ReviewComment {
  path?: string
  line?: number | null
  original_line?: number | null
  body?: string
  user?: { login?: string }
  created_at?: string
}

export function formatReviewComments(comments: ReviewComment[]): string {
  if (comments.length === 0) return "(no inline review comments)"
  const lines: string[] = []
  for (const comment of comments.slice(0, COMMENT_MAX_COUNT)) {
    const where = `${comment.path ?? "?"}:${comment.line ?? comment.original_line ?? "?"}`
    lines.push(`${comment.user?.login ?? "unknown"} @ ${where}`)
    lines.push(capText((comment.body ?? "").trim(), COMMENT_MAX_CHARS))
    lines.push("")
  }
  if (comments.length > COMMENT_MAX_COUNT)
    lines.push(`[... ${comments.length - COMMENT_MAX_COUNT} more comments omitted]`)
  return lines.join("\n").trimEnd()
}

export interface IssueComment {
  body?: string
  author?: { login?: string }
}

export function formatIssue(
  issue: { number: number; title: string; state: string; body?: string; author?: { login?: string } },
  comments: IssueComment[],
): string {
  const lines = [
    `#${issue.number} ${issue.title} (${issue.state})`,
    `by ${issue.author?.login ?? "unknown"}`,
    "",
    capText((issue.body ?? "").trim(), BODY_MAX_CHARS) || "(no body)",
  ]
  const shown = comments.slice(0, COMMENT_MAX_COUNT)
  if (shown.length > 0) {
    lines.push("", "## comments")
    for (const comment of shown) {
      lines.push(`${comment.author?.login ?? "unknown"}:`)
      lines.push(capText((comment.body ?? "").trim(), COMMENT_MAX_CHARS))
      lines.push("")
    }
    if (comments.length > COMMENT_MAX_COUNT)
      lines.push(`[... ${comments.length - COMMENT_MAX_COUNT} more comments omitted]`)
  }
  return lines.join("\n").trimEnd()
}

export function formatListRows(rows: Array<{ number: number; title: string; author?: { login?: string }; updatedAt?: string }>): string {
  if (rows.length === 0) return "(none)"
  return rows.map((row) => `#${row.number} ${row.title} — ${row.author?.login ?? "?"}`).join("\n")
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// 261024 Red RC-A02 读取上限：gh 单次输出收满 512KB 即停读并杀进程。
// 输出端上限（diff 50KB / body 4K）不等于读取端上限——「给模型的diff有50KB限制」
// 不代表「收集过程中也只占50KB」。512KB 对全部读侧操作绰绰有余（最大合法输出是
// reviews 双查询 JSON，~30 条评论 × 1.2K 字符 ≈ 72KB），超限必属异常输入。
const READ_MAX_BYTES = 512 * 1024
const STDERR_MAX_BYTES = 64 * 1024

// 261024 Red RC-A02 有界流读取：收满 limit 即 cancel，不再缓冲子进程的剩余输出。
export async function readBounded(
  stream: ReadableStream<Uint8Array> | undefined,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  while (total < limit) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total >= limit) {
      truncated = true
      break
    }
  }
  if (truncated)
    try {
      await reader.cancel()
    } catch {
      // 261024 Red 进程被杀后流可能已关闭，cancel 失败无害——上限已达即目的达成
    }
  const merged = new Uint8Array(Math.min(total, limit))
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= merged.length) break
    merged.set(chunk.subarray(0, merged.length - offset), offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(merged), truncated }
}

// 261024 Red RC-A02 spawnSync→异步：同步子进程会卡死整个后端事件循环（gh 撞上慢网络
// 时 30s 内所有并发请求一起冻结）。异步 spawn + stdout/stderr 并发读取（防管道写满
// 死锁）+ 超时 kill。bin/timeout 可注入仅为单测，生产路径恒为 gh / 30s。
export async function runGh(
  args: string[],
  cwd: string,
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; stdout: string; truncated?: boolean } | { ok: false; error: string }> {
  const bin = opts.bin ?? "gh"
  const timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    proc = Bun.spawn([bin, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch {
    return { ok: false, error: "gh CLI 未安装或不在 PATH（安装后跑 gh auth login）" }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      // 261024 Red 已退出的进程 kill 会抛；此时无需再杀
    }
  }, timeoutMs)
  let stdout: { text: string; truncated: boolean }
  let stderr: { text: string; truncated: boolean }
  try {
    ;[stdout, stderr] = await Promise.all([
      readBounded(proc.stdout, READ_MAX_BYTES),
      readBounded(proc.stderr, STDERR_MAX_BYTES),
    ])
    await proc.exited
  } finally {
    clearTimeout(timer)
  }
  if (timedOut || proc.exitCode === null)
    return { ok: false, error: `gh ${args.slice(0, 2).join(" ")} 超时（${Math.round(timeoutMs / 1000)}s），已终止子进程` }
  if (proc.exitCode !== 0 && !stdout.truncated) {
    // gh pr checks 在检查未全绿时也用非零退出码，但 stdout 就是状态表——有输出即视为成功。
    if (args[0] === "pr" && args[1] === "checks" && stdout.text.trim().length > 0) return { ok: true, stdout: stdout.text }
    const hint = /auth/i.test(stderr.text)
      ? "（gh 未认证：gh auth login）"
      : /no git remotes|not a git repository|could not determine/i.test(stderr.text)
        ? "（当前目录不是 GitHub 仓库）"
        : ""
    return { ok: false, error: `gh ${args.slice(0, 2).join(" ")} 失败 (exit ${proc.exitCode}): ${capText((stderr.text || stdout.text).trim(), 400)}${hint}` }
  }
  // 261024 Red RC-A02 stdout 被我们主动截断时，子进程随后因管道关闭吃 EPIPE 非零退出
  // 是截断的副作用而非 gh 失败——按截断上报，不按错误上报。
  return { ok: true, stdout: stdout.text, ...(stdout.truncated ? { truncated: true } : {}) }
}

export const GitHubTool = Tool.define(
  "github",
  Effect.gen(function* () {
    const execute = (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const cwd = instance.directory
        const needNumber = ["pr", "pr_reviews", "pr_checks", "pr_diff", "issue"]
        if (needNumber.includes(params.operation) && params.number === undefined) {
          return { title: "github", metadata: {}, output: `${params.operation} 需要 number 参数（PR/issue 编号）` }
        }
        const n = params.number

        if (params.operation === "pr" || params.operation === "pr_diff" || params.operation === "pr_checks") {
          const args =
            params.operation === "pr"
              ? ["pr", "view", String(n), "--json", "number,title,state,isDraft,author,baseRefName,headRefName,additions,deletions,changedFiles,body,url"]
              : params.operation === "pr_diff"
                ? ["pr", "diff", String(n)]
                : ["pr", "checks", String(n)]
          const result = yield* Effect.promise(() => runGh(args, cwd))
          if (!result.ok) return { title: "github", metadata: {}, output: result.error }
          if (params.operation === "pr") {
            if (result.truncated)
              return { title: `github pr #${n}`, metadata: {}, output: `PR 元数据超过 ${READ_MAX_BYTES}B 读取上限（异常大的 PR），已放弃解析` }
            const pr = parseJson(result.stdout) as PrInfo | undefined
            return {
              title: `github pr #${n}`,
              metadata: { operation: params.operation },
              output: pr ? formatPr(pr) : capText(result.stdout, BODY_MAX_CHARS),
            }
          }
          if (params.operation === "pr_diff") {
            return {
              title: `github pr diff #${n}`,
              metadata: { operation: params.operation },
              output: capBytes(result.stdout, DIFF_MAX_BYTES),
            }
          }
          return {
            title: `github pr checks #${n}`,
            metadata: { operation: params.operation },
            output: capText(result.stdout.trim(), BODY_MAX_CHARS) || "(no checks reported)",
          }
        }

        if (params.operation === "pr_reviews") {
          // 顶层 reviews（approve/request changes + 总结性评论）
          const reviews = yield* Effect.promise(() =>
            runGh(["pr", "view", String(n), "--json", "reviews"], cwd),
          )
          if (!reviews.ok) return { title: "github", metadata: {}, output: reviews.error }
          // 内联评论：REST API 一页 30 条，与 COMMENT_MAX_COUNT 同量级
          const inline = yield* Effect.promise(() =>
            runGh(["api", `repos/{owner}/{repo}/pulls/${n}/comments`], cwd),
          )
          const lines: string[] = []
          if (reviews.truncated)
            lines.push(`(reviews 超过 ${READ_MAX_BYTES}B 读取上限，已放弃解析)`)
          const parsedReviews = reviews.truncated
            ? []
            : ((parseJson(reviews.stdout) as { reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }> } | undefined)?.reviews ?? [])
          const substantive = parsedReviews.filter((review) => (review.body ?? "").trim().length > 0)
          if (substantive.length > 0) {
            lines.push("## reviews")
            for (const review of substantive.slice(0, COMMENT_MAX_COUNT))
              lines.push(`${review.author?.login ?? "?"} [${review.state ?? "?"}]: ${capText(review.body!.trim(), COMMENT_MAX_CHARS)}`)
            lines.push("")
          }
          if (inline.ok) {
            lines.push("## inline comments")
            lines.push(
              inline.truncated
                ? `(inline comments 超过 ${READ_MAX_BYTES}B 读取上限，已放弃解析)`
                : formatReviewComments((parseJson(inline.stdout) as ReviewComment[] | undefined) ?? []),
            )
          } else {
            lines.push(`## inline comments\n(拉取失败: ${inline.error})`)
          }
          return { title: `github pr reviews #${n}`, metadata: { operation: params.operation }, output: lines.join("\n") }
        }

        if (params.operation === "issue") {
          const result = yield* Effect.promise(() =>
            runGh(
              ["issue", "view", String(n), "--json", "number,title,state,author,body,comments"],
              cwd,
            ),
          )
          if (!result.ok) return { title: "github", metadata: {}, output: result.error }
          if (result.truncated)
            return { title: `github issue #${n}`, metadata: {}, output: `issue 内容超过 ${READ_MAX_BYTES}B 读取上限（异常大的 issue），已放弃解析` }
          const issue = parseJson(result.stdout) as
            | { number: number; title: string; state: string; body?: string; author?: { login?: string }; comments?: IssueComment[] }
            | undefined
          return {
            title: `github issue #${n}`,
            metadata: { operation: params.operation },
            output: issue
              ? formatIssue(issue, issue.comments ?? [])
              : capText(result.stdout, BODY_MAX_CHARS),
          }
        }

        // list
        const kind = params.kind ?? "pr"
        const limit = Math.min(Math.max(params.limit ?? 20, 1), 50)
        const result = yield* Effect.promise(() =>
          runGh(
            [
              kind,
              "list",
              "--state",
              params.state ?? "open",
              "--limit",
              String(limit),
              "--json",
              "number,title,author,updatedAt",
            ],
            cwd,
          ),
        )
        if (!result.ok) return { title: "github", metadata: {}, output: result.error }
        if (result.truncated)
          return { title: `github ${kind} list`, metadata: {}, output: `列表输出超过 ${READ_MAX_BYTES}B 读取上限，请加 limit 参数收窄` }
        const rows = (parseJson(result.stdout) as Array<{ number: number; title: string; author?: { login?: string } }> | undefined) ?? []
        return {
          title: `github ${kind} list`,
          metadata: { operation: params.operation, count: rows.length },
          output: formatListRows(rows),
        }
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute,
    }
  }),
)
