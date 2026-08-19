import crypto from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ModelMessage } from "ai"
import { Flag } from "@redcode-ai/core/flag/flag"
import { MAX_SESSIONS, SESSION_TTL_MS, sessionEvictor } from "@/util/session-evictor"

// 260804 Red 起的前缀断裂探针，260819 cc 从 prompt.ts 抽出来并转正。
//
// 原注释写的是「诊断完成后整块删除」，但它在 prompt.ts 的 runLoop 里活了半个月还在长功能
// （5670d86 刚给它的 key 补了 modelKey），而且 08-19 修 prune-skip 那次就是靠它的日志拿到
// 「39 次跳水吃掉 4528k token」这个数的 —— 它是有用的，不该删；该做的是别让它继续以
// 「临时代码」的姿态赖在热路径上。这次把四件事补齐：
//
//   1) 有开关（REDCODE_DISABLE_PREFIX_PROBE=1 关掉），默认开——哥哥的前缀缓存排查还在进行中，
//      默认关会静默掐掉他的数据来源。
//   2) 指纹表有界。原来是 globalThis 上一个永不回收的 Map，5670d86 给 key 加上 modelKey 之后
//      条目数还从「会话数」涨成了「会话数 × 模型数」。
//   3) 写盘不再是同步的。原来 appendFileSync 直接压在 prompt 构造主路径上。
//   4) 日志有上限会轮转。原来无限追加，实测已经 1.4 MB。
//
// 成本（实测 200K 上下文）：全量指纹 SHA-256 + JSON.stringify 约 2.8 ms/轮。不致命，
// 但这是为诊断付的钱，所以给了开关。
const LOG_NAME = "redcode-prefix-debug.log"
const LOG_MAX_BYTES = 8 * 1024 * 1024

// 260819 cc 路径可覆盖：默认落 os.tmpdir()，但用例绝不能碰那一份——哥哥正在用它排查前缀
// 缓存，reset() 会把它删掉。每次取值而不是模块加载时定，测试可以按用例换路径。
const logPath = () => process.env["REDCODE_PREFIX_PROBE_LOG"] || path.join(os.tmpdir(), LOG_NAME)

const g = globalThis as typeof globalThis & { __rc_prefix_probe?: Map<string, string[]> }
const store = (g.__rc_prefix_probe ??= new Map<string, string[]>())
const evictor = sessionEvictor({
  ttlMs: SESSION_TTL_MS,
  max: MAX_SESSIONS,
  drop: (key) => (store.delete(key) ? 1 : 0),
})

const h = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8)

// 写盘串成一条链：appendFile 之间不保证顺序，而这份日志是靠行序读的。
let writeChain: Promise<void> = Promise.resolve()

async function rotate() {
  const p = logPath()
  const stat = await fsp.stat(p).catch(() => undefined)
  if (!stat || stat.size < LOG_MAX_BYTES) return
  // 只留一份上一代：诊断看的是最近的断裂，再多份没意义还占地方
  await fsp.rename(p, p + ".1").catch(() => {})
}

function append(line: string) {
  writeChain = writeChain
    .then(rotate)
    .then(() => fsp.appendFile(logPath(), line))
    // 探针写失败绝不能影响请求主路径（260804 硬编码 E: 盘那次就是这么把 prompt 构造弄崩的）
    .catch(() => {})
}

export interface ProbeInput {
  sessionID: string
  /** providerID/modelID —— 指纹必须按模型分桶，否则同会话切模型会逐条不等、报假断裂 */
  modelKey: string
  system: string[]
  messages: ModelMessage[]
  reminderLength: number
}

/**
 * 记录本轮已稳定化消息的逐条指纹，与上一轮同 (会话, 模型) 的指纹比对；只在真的断裂时输出明细。
 * 健康轮次只写一行，日志不会爆，也不必等复现——挂着，出问题那一轮自己会说话。
 */
export function record(input: ProbeInput): void {
  if (Flag.REDCODE_DISABLE_PREFIX_PROBE) return

  // 指纹取全量 content 而不是前 N 个字符：尾部被截掉的差异正是最容易漏的那种
  const fp = input.messages.map((m, i) => {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    return `${i}:${m.role}:${c.length}:${h(c)}`
  })

  const key = `${input.sessionID}|${input.modelKey}`
  const prev = store.get(key)
  store.set(key, fp)
  evictor.touch(key)

  const detail: string[] = []
  if (prev) {
    if (fp.length < prev.length) detail.push(`  ⚠ 消息条数减少：${prev.length} -> ${fp.length}`)
    const common = Math.min(prev.length, fp.length)
    let at = -1
    for (let i = 0; i < common; i++) {
      if (prev[i] === fp[i]) continue
      at = i
      break
    }
    if (at >= 0) {
      // 这一条就是缓存前缀的断点：它之前的内容可复用，它和它之后的必须重新写缓存
      detail.push(`  ⚠ 前缀在第 ${at} 条断裂（共 ${fp.length} 条）`)
      detail.push(`      上一轮 ${prev[at]}`)
      detail.push(`      这一轮 ${fp[at]}`)
      const tail = prev.slice(at).filter((x) => !fp.includes(x)).length
      detail.push(`      断点之后上一轮有 ${tail} 条在本轮找不到同样的指纹`)
    }
  }

  append(
    `${new Date().toISOString()} ses=${input.sessionID} model=${input.modelKey}` +
      ` sysLen=${input.system.length} sysHash=${h(input.system.join(""))} n=${fp.length}` +
      ` reminder=${input.reminderLength}` +
      (detail.length ? `\n${detail.join("\n")}\n${fp.join("\n")}\n---\n` : `\n`),
  )
}

/** 测试钩子：等写盘链排空，断言日志内容前调用 */
export const flush = () => writeChain

/** 测试钩子：清空指纹表与日志文件 */
export function reset() {
  store.clear()
  evictor.clear()
  try {
    fs.rmSync(logPath(), { force: true })
    fs.rmSync(logPath() + ".1", { force: true })
  } catch {}
}

/** 测试钩子：当前驻留的 (会话,模型) 指纹条目数 */
export const size = () => store.size

export const LOG_PATH = logPath
export const MAX_BYTES = LOG_MAX_BYTES
export * as PrefixProbe from "./prefix-probe"
