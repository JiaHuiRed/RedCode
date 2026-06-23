#!/usr/bin/env node
// 260609 Red 教训按需召回 —— 解析 ~/.redcode/MEMORY.md 的 ### 教训块，按 query 打分，只输出命中的几条。
// 260623 Red 语义搜索增强 —— 双路召回：关键词打分 + Ollama embedding cosine similarity，分数融合排序。
// 中文友好打分：英文按词、中文按 2/3 字窗口；不需要 db，纯现场解析（教训规模小，毫秒级）。
// 纯 JS(.mjs)：只用 node:fs/path/os，node 与 bun 都能跑。用 node 调用以绕过 PowerShell 对 bun.ps1 的执行策略封禁。
// 用法：node recall-memory.mjs <关键词...>     由 /recall 斜杠命令通过 !`...` 内联调用。
//       node recall-memory.mjs --index          预计算 embedding 缓存（写 MEMORY.md 后运行一次）。
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const MEMORY_PATH = process.env.REDCODE_MEMORY || path.join(os.homedir(), ".redcode", "MEMORY.md")
const EMBED_CACHE = process.env.REDCODE_EMBED_CACHE || path.join(path.dirname(MEMORY_PATH), "memory", "embeddings.json")
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434"
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text"
const LIMIT = Number(process.env.RECALL_LIMIT) || 5
const MAX_CHARS = 4500 // 注入上限，超出截断，避免召回反而撑爆上下文
const SEMANTIC_WEIGHT = 0.6 // 语义分数权重（关键词 0.4）
const EMBED_TIMEOUT = 3000 // Ollama 超时 ms

// ── 解析 ──────────────────────────────────────────────
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

// ── 关键词打分 ────────────────────────────────────────
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

function keywordScore(block, ts) {
  const hay = (block.header + "\n" + block.body).toLowerCase()
  const head = block.header.toLowerCase()
  let s = 0
  for (const [t, w] of ts) {
    const hits = hay.split(t).length - 1
    if (hits > 0) s += hits * w + (head.includes(t) ? w * 3 : 0) // 命中标题额外加权
  }
  return s
}

// ── Embedding / 语义搜索 ─────────────────────────────
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

async function ollamaEmbed(texts) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT)
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.embeddings ?? null
  } catch {
    return null // Ollama not running — silent fallback
  } finally {
    clearTimeout(timer)
  }
}

async function ollamaAvailable() {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

// 读 embedding 缓存 { version, memoryMtime, model, blocks: [{key, embedding}] }
function loadCache() {
  if (!existsSync(EMBED_CACHE)) return null
  try {
    return JSON.parse(readFileSync(EMBED_CACHE, "utf-8"))
  } catch {
    return null
  }
}

function saveCache(cache) {
  const dir = path.dirname(EMBED_CACHE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(EMBED_CACHE, JSON.stringify(cache), "utf-8")
}

// 块的缓存 key = header + body 前 200 字（避免 body 微调就全量失效）
function blockKey(b) {
  return b.header + "|" + b.body.trim().slice(0, 200)
}

// 预计算所有块的 embedding，写入缓存
async function indexEmbeddings(blocks) {
  if (!(await ollamaAvailable())) {
    console.error(`(Ollama 未运行 ${OLLAMA_URL}，跳过 embedding 预计算)`)
    return null
  }
  const texts = blocks.map((b) => b.header + "\n" + b.body.trim())
  const embeddings = await ollamaEmbed(texts)
  if (!embeddings || embeddings.length !== blocks.length) {
    console.error("(embedding 计算失败，跳过语义搜索)")
    return null
  }
  const memoryMtime = existsSync(MEMORY_PATH) ? statSync(MEMORY_PATH).mtimeMs : 0
  const cache = {
    version: 1,
    memoryMtime,
    model: EMBED_MODEL,
    blocks: blocks.map((b, i) => ({ key: blockKey(b), embedding: embeddings[i] })),
  }
  saveCache(cache)
  return cache
}

// 获取缓存（有效则复用，过期则重建）
async function getEmbeddings(blocks) {
  const cache = loadCache()
  const memoryMtime = existsSync(MEMORY_PATH) ? statSync(MEMORY_PATH).mtimeMs : 0
  if (cache && cache.model === EMBED_MODEL && cache.memoryMtime === memoryMtime) {
    // 缓存有效，按 blockKey 匹配（顺序可能变）
    const map = new Map(cache.blocks.map((b) => [b.key, b.embedding]))
    const matched = blocks.map((b) => map.get(blockKey(b)) ?? null)
    // 全部命中才复用
    if (matched.every((e) => e !== null)) return matched
  }
  // 缓存过期或不完整，重建
  const rebuilt = await indexEmbeddings(blocks)
  if (!rebuilt) return null
  return rebuilt.blocks.map((b) => b.embedding)
}

// ── 双路融合 ──────────────────────────────────────────
function normalize(scores) {
  const max = Math.max(...scores)
  return max > 0 ? scores.map((s) => s / max) : scores
}

// ── 主流程 ────────────────────────────────────────────
const args = process.argv.slice(2)

// --index 模式：只预计算 embedding，不召回
if (args[0] === "--index") {
  if (!existsSync(MEMORY_PATH)) {
    console.log(`(未找到 ${MEMORY_PATH})`)
    process.exit(0)
  }
  const blocks = parse(readFileSync(MEMORY_PATH, "utf-8"))
  console.log(`解析到 ${blocks.length} 个教训块，开始计算 embedding...`)
  const result = await indexEmbeddings(blocks)
  if (result) {
    console.log(`embedding 缓存已写入 ${EMBED_CACHE}（${result.blocks.length} 条，模型 ${EMBED_MODEL}）`)
  }
  process.exit(0)
}

const query = args.join(" ").trim()
if (!query) {
  console.log("用法：/recall <关键词>　例：/recall 代理 / /recall MCP 进程泄漏\n      --index　预计算 embedding 缓存")
  process.exit(0)
}
if (!existsSync(MEMORY_PATH)) {
  console.log(`(未找到 ${MEMORY_PATH}，无教训可召回)`)
  process.exit(0)
}

const blocks = parse(readFileSync(MEMORY_PATH, "utf-8"))
const ts = terms(query)

// 关键词打分
const kwScores = blocks.map((b) => keywordScore(b, ts))

// 语义打分（尝试，失败则纯关键词）
let semScores = null
const embeddings = await getEmbeddings(blocks)
if (embeddings) {
  const qEmb = await ollamaEmbed([query])
  if (qEmb && qEmb[0]) {
    semScores = embeddings.map((e) => (e ? Math.max(0, cosine(qEmb[0], e)) : 0))
  }
}

// 融合排序
const kwNorm = normalize(kwScores)
const semNorm = semScores ? normalize(semScores) : null
const ranked = blocks
  .map((b, i) => {
    const kw = kwNorm[i]
    const sem = semNorm ? semNorm[i] : 0
    // 有语义时加权融合；无语义时纯关键词
    const final = semNorm ? kw * (1 - SEMANTIC_WEIGHT) + sem * SEMANTIC_WEIGHT : kw
    return { b, s: final, kwRaw: kwScores[i], sem: semScores?.[i] ?? 0 }
  })
  .filter((x) => x.s > 0)
  .sort((a, b) => b.s - a.s)
  .slice(0, LIMIT)

if (ranked.length === 0) {
  console.log(`(没搜到与「${query}」相关的教训。可换个关键词，或直接读 ${MEMORY_PATH})`)
  process.exit(0)
}

const mode = semNorm ? "关键词+语义" : "仅关键词"
const parts = [`## 召回「${query}」相关教训（${ranked.length} 条，${mode}）\n`]
for (const { b } of ranked) parts.push(`### ${b.header}\n${b.body.trim()}`)
const text = parts.join("\n\n")
console.log(text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n…(已截断)" : text)
