#!/usr/bin/env bun
// 260811 cc：把一轮请求的耗时拆成「等第一个字」与「吐字」两段，回答"首次交互为什么慢"。
// 数据来自 assistant 消息的 time.created / time.firstChunk / time.completed（埋点见
// session/processor.ts 的 llm.ttft）。埋点上线前的历史消息没有 firstChunk，会标成 "-"。
//
// 用法：
//   bun run script/ttft.ts                 最近 30 轮（跨会话）
//   bun run script/ttft.ts <sessionID>     指定会话
//   bun run script/ttft.ts --db <path>     指定库（默认 ~/.redcode/data/redcode.db）
import { Database } from "bun:sqlite"
import os from "os"
import path from "path"

const argv = Bun.argv.slice(2)
const dbFlag = argv.indexOf("--db")
const dbPath = dbFlag >= 0 ? argv[dbFlag + 1]! : path.join(os.homedir(), ".redcode", "data", "redcode.db")
const sessionID = argv.find((a) => a.startsWith("ses_"))

const db = new Database(dbPath, { readonly: true })
const rows = sessionID
  ? db
      .query<{ data: string }, [string]>(`SELECT data FROM message WHERE session_id = ? ORDER BY id`)
      .all(sessionID)
  : db.query<{ data: string }, []>(`SELECT data FROM message ORDER BY time_created DESC LIMIT 200`).all()

type Row = {
  t: number
  wait: number | undefined
  gen: number | undefined
  total: number
  hit: number
  uncached: number
  out: number
  ctx: number
  model: string
}
const list: Row[] = []
for (const r of rows) {
  let d: any
  try {
    d = JSON.parse(r.data)
  } catch {
    continue
  }
  if (d.role !== "assistant" || !d.tokens || !d.time?.completed) continue
  const tk = d.tokens
  const cr = tk.cache?.read ?? 0
  const cw = tk.cache?.write ?? 0
  const inp = tk.input ?? 0
  const ctx = inp + cr + cw
  if (!ctx) continue
  const total = (d.time.completed - d.time.created) / 1000
  const wait = d.time.firstChunk ? (d.time.firstChunk - d.time.created) / 1000 : undefined
  list.push({
    t: d.time.created,
    wait,
    gen: wait === undefined ? undefined : total - wait,
    total,
    hit: (cr / ctx) * 100,
    uncached: inp + cw,
    out: tk.output ?? 0,
    ctx,
    model: d.modelID ?? "?",
  })
}
list.sort((a, b) => a.t - b.t)

const fmt = (ms: number) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false })
const n = (v: number | undefined, w: number, digits = 1) => (v === undefined ? "-" : v.toFixed(digits)).padStart(w)

console.log(`库：${dbPath}`)
console.log(`\n时刻      总耗时  等首字  吐字   命中率  上下文  未命中  输出  吐字速率  模型`)
for (const r of list.slice(-30)) {
  const rate = r.gen && r.gen > 0 ? r.out / r.gen : undefined
  console.log(
    `${fmt(r.t)} ${n(r.total, 7)}s ${n(r.wait, 6)}s ${n(r.gen, 6)}s ${n(r.hit, 6, 0)}% ${String(Math.round(r.ctx / 1000)).padStart(5)}k ${String(r.uncached).padStart(7)} ${String(r.out).padStart(5)} ${n(rate, 7)}/s  ${r.model}`,
  )
}

const withTtft = list.filter((r) => r.wait !== undefined)
if (!withTtft.length) {
  console.log(`\n（这批数据里还没有 firstChunk —— 埋点是 260811 加的，之前的消息没有这个字段。跑一轮新对话再看。）`)
} else {
  const med = (arr: number[]) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? 0
  const cold = withTtft.filter((r) => r.hit < 50)
  const hot = withTtft.filter((r) => r.hit >= 50)
  console.log(`\n== 中位数分解（共 ${withTtft.length} 轮有埋点）==`)
  const show = (label: string, g: Row[]) =>
    g.length &&
    console.log(
      `${label.padEnd(16)} ${String(g.length).padStart(4)} 轮  等首字 ${med(g.map((r) => r.wait!)).toFixed(1)}s  吐字 ${med(g.map((r) => r.gen!)).toFixed(1)}s`,
    )
  show("缓存命中<50%", cold)
  show("缓存命中≥50%", hot)
  console.log(
    `\n判读：等首字长 = 排队/预填（供应商侧或未命中太多）；吐字长 = 解码慢（看吐字速率）。` +
      `\n      两段都短却总耗时长，说明时间花在本地（去看 session.tools / instruction 的耗时日志）。`,
  )
}
db.close()
