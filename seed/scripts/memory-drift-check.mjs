#!/usr/bin/env node
// 261019 Red Memory V4 漂移探针（哥哥点名：快照链路四步全靠人记，零步会响——
//   "db 写后没 export / export 后没 commit / commit 后没 push / 对端 pull 后没回填"）。
// 每步各自探测，确定发生才报 tripped；git/文件失败一律报 unknown 不冒充干净
//   （失效语义：刷新失败不得报成功，见 docs/notes/proposed/architecture/2026-10-19-memory-v4.md）。
// 跨机事实：lessons-backup.<host>.md 是 global 全文跨机唯一通路（入库推送）；
//   local-backup 与 project 级 db 全文均不出本机，project 内容跨机靠 tracked note。
// 用法：node|bun memory-drift-check.mjs [--json]
// 导出：collectSignals()/formatDriftNotice() 给 plugin/memory-recall.js 复用（会话首轮注入
//   ≤300 字节提醒，主会话代理转告用户，子代理忽略）。两边逻辑同源，改这里别只改一半。
// 决策记录：docs/notes/proposed/architecture/2026-10-19-memory-v4.md（批次 A 新增件）
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const HOME = join(homedir(), ".redcode")
const isBun = typeof globalThis.Bun !== "undefined"

// env 每次调用现读（插件进程内模块只 import 一次，顶层读常量会让测试/多环境串场）
function resolveConfig() {
  return {
    dbPath: process.env.REDCODE_MEMORY_DB || join(HOME, "supermemory.db"),
    // 测试可指到临时仓；默认私仓
    repoRoot: process.env.REDCODE_MEMORY_DRIFT_REPO || HOME,
  }
}

const dbCache = new Map()
async function getDb(dbPath) {
  const cached = dbCache.get(dbPath)
  if (cached) return cached
  const mod = isBun ? await import("bun:sqlite") : await import("node:sqlite")
  const Ctor = isBun ? mod.Database : mod.DatabaseSync
  // 只读选项名两边不一样（memory-recall.js 260813 踩过）：bun 认 readonly，node 认 readOnly
  const d = new Ctor(dbPath, isBun ? { readonly: true } : { readOnly: true })
  dbCache.set(dbPath, d)
  return d
}

// 快照文件定位：先精确本机 host，找不到就取目录下唯一一份（单机场景容错）
function findOwnSnapshot(repoRoot) {
  const dir = join(repoRoot, "memory")
  const exact = join(dir, `lessons-backup.${hostname()}.md`)
  if (existsSync(exact)) return exact
  const all = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^lessons-backup\..+\.md$/.test(f))
    : []
  return all.length === 1 ? join(dir, all[0]) : null
}

// 全部快照（含对端，如 lessons-backup.Red314.md）——信号 4 用：跨机裂缝（对端有条本机没有）
// 只有查对端才看得见，本机快照由本机 db 导出、天然自洽
function findAllSnapshots(repoRoot) {
  const dir = join(repoRoot, "memory")
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^lessons-backup\..+\.md$/.test(f))
        .map((f) => join(dir, f))
    : []
}

// git 只做本地读操作（status/rev-list 不联网不弹窗），超时兜底防挂起
function git(args, repoRoot) {
  const r = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, err: r.stderr }
}

// 信封：确定发生才 tripped；拿不到证据一律 unknown，不冒充干净
const unknown = (why) => ({ tripped: false, unknown: true, detail: why })
const clean = (detail) => ({ tripped: false, unknown: false, detail })
const tripped = (detail) => ({ tripped: true, unknown: false, detail })

// 信号 1：global 库有比快照新的条目 → 该重跑 export。两边都是本地时间 "YYYY-MM-DD HH:MM:SS"，零填充字符串可直接比
async function signalDbNewer(snapshotPath, dbPath) {
  try {
    const text = readFileSync(snapshotPath, "utf8")
    const exported = text.match(/^> 导出时间：(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/m)?.[1]
    if (!exported) return unknown("快照缺「导出时间」行")
    const d = await getDb(dbPath)
    const stmt = isBun ? d.query("SELECT max(updated_at) AS m FROM memories WHERE project='global'") : d.prepare("SELECT max(updated_at) AS m FROM memories WHERE project='global'")
    const latest = stmt.get()?.m
    if (!latest) return clean("global 库为空或无时间戳")
    return latest > exported ? tripped(`db 最新 ${latest} > 快照导出 ${exported}，需重跑 export-memory-backup.mjs`) : clean(`db ${latest} ≤ 快照 ${exported}`)
  } catch (e) {
    return unknown(String(e?.message ?? e))
  }
}

// 信号 2：快照文件在私仓有未提交改动 → 该 commit
function signalSnapshotDirty(snapshotPath, repoRoot) {
  if (!snapshotPath) return unknown("找不到 lessons-backup 快照文件")
  const rel = snapshotPath.slice(repoRoot.length + 1)
  const r = git(["status", "--porcelain", "--", rel], repoRoot)
  if (!r.ok) return unknown(`git status 失败：${(r.err || "").trim().split("\n")[0] || "exit != 0"}`)
  return r.out.trim() ? tripped(`${rel} 有未提交改动`) : clean(`${rel} 无未提交改动`)
}

// 信号 3：私仓领先 origin（上次 fetch 时的已知位置，不联网）→ 该 push
function signalAheadOfOrigin(repoRoot) {
  const r = git(["rev-list", "--count", "origin/master..master"], repoRoot)
  if (!r.ok) return unknown("origin/master 不可知（未 fetch 过或无远端）")
  const n = Number(r.out.trim())
  return n > 0 ? tripped(`本地领先 origin ${n} 个提交（快照要推过去才有跨机价值）`) : clean("与 origin 持平")
}

// 信号 4：快照（含对端）有本机缺的 global 条目 → 该回填。按内容比对（db 行 id 跨机不对齐，#N 编号在正文里）
async function signalSnapshotMissing(snapshotPaths, dbPath) {
  try {
    if (snapshotPaths.length === 0) return unknown("找不到快照文件")
    const d = await getDb(dbPath)
    const stmt = isBun ? d.query("SELECT content FROM memories WHERE project='global'") : d.prepare("SELECT content FROM memories WHERE project='global'")
    const local = new Set(stmt.all().map((r) => String(r.content ?? "").trim()))
    const missing = []
    for (const path of snapshotPaths) {
      const text = readFileSync(path, "utf8")
      const peer = path.includes(hostname()) ? "" : `（${path.split(/[\\/]/).pop()}）`
      for (const chunk of text.split(/\n---\n/)) {
        const header = chunk.match(/^## \[([^\]]+)\] id=\d+ project=(\S+)/m)
        if (!header || header[2] !== "global") continue
        const body = chunk.replace(/^## .*\n/m, "").replace(/<!-- created_at:[^>]*-->/, "").trim()
        if (body && !local.has(body)) missing.push(`${peer}${body.split("\n")[0].slice(0, 50)}`)
      }
    }
    return missing.length
      ? tripped(`快照有 ${missing.length} 条本机缺失，首条：${missing[0]}`)
      : clean("快照条目本机全有")
  } catch (e) {
    return unknown(String(e?.message ?? e))
  }
}

export async function collectSignals() {
  const { dbPath, repoRoot } = resolveConfig()
  const own = findOwnSnapshot(repoRoot)
  const allSnapshots = findAllSnapshots(repoRoot)
  const [dbNewer, dirty, ahead, missing] = await Promise.all([
    own ? signalDbNewer(own, dbPath) : unknown("找不到快照文件"),
    Promise.resolve(signalSnapshotDirty(own, repoRoot)),
    Promise.resolve(signalAheadOfOrigin(repoRoot)),
    signalSnapshotMissing(allSnapshots.length > 0 ? allSnapshots : own ? [own] : [], dbPath),
  ])
  return { snapshot: own, dbNewerThanSnapshot: dbNewer, snapshotDirty: dirty, aheadOfOrigin: ahead, snapshotMissingLocally: missing }
}

// ≤300 字节硬上限（V4 注入预算纪律）；子代理显式忽略，主会话代理转告用户，不代做 commit/push
export function formatDriftNotice(signals) {
  const parts = []
  if (signals.dbNewerThanSnapshot?.tripped) parts.push("db 有比快照新的 global 条目")
  if (signals.snapshotDirty?.tripped) parts.push("快照有未提交改动")
  if (signals.aheadOfOrigin?.tripped) parts.push(signals.aheadOfOrigin.detail)
  if (signals.snapshotMissingLocally?.tripped) parts.push(signals.snapshotMissingLocally.detail)
  if (parts.length === 0) return null
  return (
    `\n\n<system-reminder>\n[memory-drift] 记忆库漂移：${parts.join("；")}。` +
    "主会话代理请在回复中提醒用户：跑 scripts/memory-drift-check.mjs 看详情；快照改动需 commit+push 才跨机生效。子代理忽略本条。\n</system-reminder>"
  )
}

// ── CLI ────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const signals = await collectSignals()
  if (process.argv[2] === "--json") {
    console.log(JSON.stringify(signals, null, 2))
  } else {
    console.log(`快照：${signals.snapshot ?? "（未找到）"}`)
    for (const [name, s] of Object.entries(signals).slice(1)) {
      const mark = s.tripped ? "[!] " : s.unknown ? "[?] " : "[ok] "
      console.log(`${mark}${name}: ${s.detail}`)
    }
    console.log(formatDriftNotice(signals) ? "\n→ 有漂移，见 [!] 项。" : "\n→ 无漂移。")
  }
}
