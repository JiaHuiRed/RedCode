#!/usr/bin/env node
// 260609 Red 教训按需召回 —— 解析 ~/.redcode/MEMORY.md 的 ### 教训块，按 query 打分，只输出命中的几条。
// 中文友好打分：英文按词、中文按 2/3 字窗口；不需要 db，纯现场解析（教训规模小，毫秒级）。
// 纯 JS(.mjs)：只用 node:fs/path/os，node 与 bun 都能跑。用 node 调用以绕过 PowerShell 对 bun.ps1 的执行策略封禁。
// 用法：node recall-memory.mjs <关键词...>     由 /recall 斜杠命令通过 !`...` 内联调用。
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const MEMORY_PATH = process.env.REDCODE_MEMORY || path.join(os.homedir(), ".redcode", "MEMORY.md")
const LIMIT = Number(process.env.RECALL_LIMIT) || 5
const MAX_CHARS = 4500 // 注入上限，超出截断，避免召回反而撑爆上下文

const query = process.argv.slice(2).join(" ").trim()
if (!query) {
  console.log("用法：/recall <关键词>　例：/recall 代理 / /recall MCP 进程泄漏")
  process.exit(0)
}
if (!existsSync(MEMORY_PATH)) {
  console.log(`(未找到 ${MEMORY_PATH}，无教训可召回)`)
  process.exit(0)
}

// 把 MEMORY.md 切成 ### 教训块（遇到下一个 ### 或顶层 # 收束）
function parse(md) {
  const blocks = []
  let cur = null
  for (const line of md.split("\n")) {
    if (line.startsWith("### ")) {
      if (cur) blocks.push(cur)
      cur = { header: line.slice(4).trim(), body: "" }
      continue
    }
    if (line.startsWith("# ") || line.startsWith("## ")) {
      if (cur) blocks.push(cur)
      cur = null
      continue
    }
    if (cur) cur.body += line + "\n"
  }
  if (cur) blocks.push(cur)
  return blocks
}

// query -> 加权检索词：英文整词；中文 2/3 字滑窗。长词权重更高。
function terms(q) {
  const out = new Map()
  const bump = (t, w) => out.set(t, Math.max(out.get(t) ?? 0, w))
  const lower = q.toLowerCase()
  for (const w of lower.match(/[a-z0-9]{2,}/g) ?? []) bump(w, w.length)
  for (const run of lower.match(/[\u4e00-\u9fff]{2,}/g) ?? [])
    for (let len = 2; len <= 3; len++)
      for (let i = 0; i + len <= run.length; i++) bump(run.slice(i, i + len), len)
  return out
}

function score(block, ts) {
  const hay = (block.header + "\n" + block.body).toLowerCase()
  const head = block.header.toLowerCase()
  let s = 0
  for (const [t, w] of ts) {
    const hits = hay.split(t).length - 1
    if (hits > 0) s += hits * w + (head.includes(t) ? w * 3 : 0) // 命中标题额外加权
  }
  return s
}

const ts = terms(query)
const ranked = parse(readFileSync(MEMORY_PATH, "utf-8"))
  .map((b) => ({ b, s: score(b, ts) }))
  .filter((x) => x.s > 0)
  .sort((a, b) => b.s - a.s)
  .slice(0, LIMIT)

if (ranked.length === 0) {
  console.log(`(没搜到与「${query}」相关的教训。可换个关键词，或直接读 ${MEMORY_PATH})`)
  process.exit(0)
}

const parts = [`## 召回「${query}」相关教训（${ranked.length} 条，按相关度）\n`]
for (const { b } of ranked) parts.push(`### ${b.header}\n${b.body.trim()}`)
const text = parts.join("\n\n")
console.log(text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n…(已截断)" : text)
