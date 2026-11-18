#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const SMALL_MESSAGE_COUNT = 128
const LARGE_MESSAGE_COUNT = 2_612
const WARMUPS = 2
const RUNS = 5
const MAX_LARGE_MEDIAN_MS = 50
const MAX_SCALING_RATIO = 6
const MAX_LARGE_MEMORY_GROWTH_BYTES = 16 * 1024 * 1024
// 261118 Red 空摘要全量回读只做灾难守卫：本机 130~175ms，留 4 倍余量防数量级退化，
// 不用于跨机器比较（不同机器、文件缓存与进程内堆状态都会改变这个绝对值）。
const MAX_EMPTY_LARGE_MEDIAN_MS = 600
const USER_PAYLOAD = "x".repeat(4_096)
// 261118 Red 有效摘要与空摘要各测一组：同一条「非空结果」断言无法区分折叠历史
// （生产主路径）与保留全部原文（摘要失败时的保护路径），旧基准因此恒红且不说明问题。
const SUMMARY_TEXT = `benchmark compaction summary ${"s".repeat(480)}`
const COMPACTION_WINDOW = 62
const TAIL_START_OFFSET = 10
const RETAINED_MESSAGES = COMPACTION_WINDOW + TAIL_START_OFFSET
type SummaryMode = "valid" | "empty"
type BudgetMetrics = {
  largeMedianMs: number
  scalingRatio: number
  largeMemoryGrowthBytes: number
  emptyLargeMedianMs: number
}
type BudgetLimits = BudgetMetrics

// 260929 Red 预算判定收敛成纯函数 + 开机自检（学 deepseek-harness 的正负控制用例）：
// 门禁自己没被测过就不算门禁。三组控制：超限必须拒、边界（==）必须过（<= 语义）、
// 全零预算下正常样本必须拒（防比较方向写反）。自检失败直接退出，不跑正式基准。
function evaluateBudgets(metrics: BudgetMetrics, limits: BudgetLimits) {
  const violations: string[] = []
  if (metrics.largeMedianMs > limits.largeMedianMs)
    violations.push(`filter_compacted_large_median_ms ${metrics.largeMedianMs.toFixed(2)} > ${limits.largeMedianMs}`)
  if (metrics.scalingRatio > limits.scalingRatio)
    violations.push(`filter_compacted_scaling_ratio ${metrics.scalingRatio.toFixed(2)} > ${limits.scalingRatio}`)
  if (metrics.largeMemoryGrowthBytes > limits.largeMemoryGrowthBytes)
    violations.push(
      `filter_compacted_large_memory_growth_bytes ${metrics.largeMemoryGrowthBytes} > ${limits.largeMemoryGrowthBytes}`,
    )
  if (metrics.emptyLargeMedianMs > limits.emptyLargeMedianMs)
    violations.push(
      `filter_compacted_empty_large_median_ms ${metrics.emptyLargeMedianMs.toFixed(2)} > ${limits.emptyLargeMedianMs}`,
    )
  return { passed: violations.length === 0, violations }
}

function selfCheckBudgets() {
  const limits: BudgetLimits = {
    largeMedianMs: MAX_LARGE_MEDIAN_MS,
    scalingRatio: MAX_SCALING_RATIO,
    largeMemoryGrowthBytes: MAX_LARGE_MEMORY_GROWTH_BYTES,
    emptyLargeMedianMs: MAX_EMPTY_LARGE_MEDIAN_MS,
  }
  const overLimit: BudgetMetrics = {
    largeMedianMs: limits.largeMedianMs + 1,
    scalingRatio: limits.scalingRatio + 1,
    largeMemoryGrowthBytes: limits.largeMemoryGrowthBytes + 1,
    emptyLargeMedianMs: limits.emptyLargeMedianMs + 1,
  }
  const atLimit: BudgetMetrics = { ...limits }
  const zeroAllowance: BudgetLimits = {
    largeMedianMs: 0,
    scalingRatio: 0,
    largeMemoryGrowthBytes: 0,
    emptyLargeMedianMs: 0,
  }
  const normalSample: BudgetMetrics = {
    largeMedianMs: 1,
    scalingRatio: 1,
    largeMemoryGrowthBytes: 1,
    emptyLargeMedianMs: 1,
  }

  const overVerdict = evaluateBudgets(overLimit, limits)
  const controls = [
    ["over-limit rejected with 4 violations", overVerdict.passed === false && overVerdict.violations.length === 4],
    ["at-limit accepted (<= semantics)", evaluateBudgets(atLimit, limits).passed],
    ["zero allowance rejects normal sample", evaluateBudgets(normalSample, zeroAllowance).passed === false],
  ] as const
  const failed = controls.filter(([, ok]) => !ok).map(([name]) => name)
  if (failed.length > 0) {
    console.error(`bench:budget self-check failed: ${failed.join("; ")}`)
    return false
  }
  console.log("bench:budget self-check passed (3/3 controls)")
  return true
}

if (!selfCheckBudgets()) process.exit(1)

const root = await mkdtemp(path.join(os.tmpdir(), "redcode-performance-"))
process.env["REDCODE_DB"] = path.join(root, "benchmark.db")
process.env["XDG_DATA_HOME"] = path.join(root, "data")
process.env["XDG_CACHE_HOME"] = path.join(root, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(root, "config")
process.env["XDG_STATE_HOME"] = path.join(root, "state")
process.env["REDCODE_DISABLE_MODELS_FETCH"] = "1"
process.env["REDCODE_DISABLE_PLUGIN_DEP_INSTALL"] = "1"

const { Effect } = await import("effect")
const { Database } = await import("../src/storage/db")
const { ProjectTable } = await import("../src/project/project.sql")
const { ProjectID } = await import("../src/project/schema")
const { MessageTable, PartTable, SessionTable } = await import("../src/session/session.sql")
const { MessageID, PartID, SessionID } = await import("../src/session/schema")
const { MessageV2 } = await import("../src/session/message-v2")
const { ModelID, ProviderID } = await import("../src/provider/schema")

type MessageIDType = import("../src/session/schema").MessageID
type SessionIDType = import("../src/session/schema").SessionID

const projectID = ProjectID.make("prj_performance")
const providerID = ProviderID.make("benchmark")
const modelID = ModelID.make("benchmark")

const messageID = (sessionKey: string, index: number) =>
  MessageID.make(`msg_${sessionKey}_${index.toString().padStart(4, "0")}`)
const partID = (sessionKey: string, index: number) =>
  PartID.make(`prt_${sessionKey}_${index.toString().padStart(4, "0")}`)

function userData(created: number) {
  return {
    role: "user" as const,
    time: { created },
    agent: "user",
    model: { providerID, modelID },
    tools: {},
  }
}

function assistantData(created: number, parentID: MessageIDType, summary = false) {
  return {
    role: "assistant" as const,
    time: { created },
    parentID,
    modelID,
    providerID,
    mode: "",
    agent: "benchmark",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...(summary ? { summary: true, finish: "stop" } : {}),
  }
}

function seedSession(sessionID: SessionIDType, sessionKey: string, messageCount: number, summary: SummaryMode) {
  const compactionIndex = messageCount - COMPACTION_WINDOW
  const tailStartIndex = compactionIndex - TAIL_START_OFFSET
  const messages: (typeof MessageTable.$inferInsert)[] = []
  const parts: (typeof PartTable.$inferInsert)[] = []

  Database.use((db) => {
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: `performance-${sessionKey}`,
        directory: root,
        title: "Performance benchmark",
        version: "benchmark",
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        time_created: 1,
        time_updated: 1,
      })
      .run()

    for (let index = 0; index < messageCount; index++) {
      const id = messageID(sessionKey, index)
      const created = index + 1
      const isSummary = index === compactionIndex + 1
      const isCompaction = index === compactionIndex

      if (index % 2 === 0 || isCompaction) {
        const data = isCompaction
          ? { type: "compaction" as const, auto: true, tail_start_id: messageID(sessionKey, tailStartIndex) }
          : { type: "text" as const, text: `benchmark user turn ${index}\n${USER_PAYLOAD}` }
        messages.push({
          id,
          session_id: sessionID,
          time_created: created,
          time_updated: created,
          data: userData(created),
        })
        parts.push({
          id: partID(sessionKey, index),
          message_id: id,
          session_id: sessionID,
          time_created: created,
          time_updated: created,
          data,
        })
        continue
      }

      messages.push({
        id,
        session_id: sessionID,
        time_created: created,
        time_updated: created,
        data: assistantData(created, messageID(sessionKey, index - 1), isSummary),
      })
      // 空摘要组只推消息、不给正文：生产代码因此保留全部历史，正是要测的保护路径。
      if (isSummary && summary === "valid") {
        const data = { type: "text" as const, text: SUMMARY_TEXT }
        parts.push({
          id: partID(sessionKey, index),
          message_id: id,
          session_id: sessionID,
          time_created: created,
          time_updated: created,
          data,
        })
      }
    }

    db.insert(MessageTable).values(messages).run()
    db.insert(PartTable).values(parts).run()
  })
}

type Variant = {
  key: string
  count: number
  summary: SummaryMode
  expected: number
}

const VARIANTS: Variant[] = [
  { key: "small-valid", count: SMALL_MESSAGE_COUNT, summary: "valid", expected: RETAINED_MESSAGES },
  { key: "large-valid", count: LARGE_MESSAGE_COUNT, summary: "valid", expected: RETAINED_MESSAGES },
  { key: "small-empty", count: SMALL_MESSAGE_COUNT, summary: "empty", expected: SMALL_MESSAGE_COUNT },
  { key: "large-empty", count: LARGE_MESSAGE_COUNT, summary: "empty", expected: LARGE_MESSAGE_COUNT },
]

const SESSIONS = new Map(
  VARIANTS.map((variant) => [variant.key, SessionID.make(`ses_performance_${variant.key.replace("-", "_")}`)]),
)

function readCompacted(variant: Variant) {
  return Effect.runSync(MessageV2.filterCompactedEffect(SESSIONS.get(variant.key)!))
}

// 261118 Red 硬断言两条路径的边界：有效组必须停在摘要与保留尾，空摘要组必须原文完整。
function verify(variant: Variant) {
  const output = readCompacted(variant)
  const [compaction, summary, tailFirst] = output
  if (output.length !== variant.expected || output.at(-1)?.info.id !== messageID(variant.key, variant.count - 1))
    throw new Error(`${variant.key} returned ${output.length} messages, expected ${variant.expected}`)
  if (variant.summary === "empty") {
    if (output[0]?.info.id !== messageID(variant.key, 0))
      throw new Error(`${variant.key} did not keep the first message`)
    return
  }
  const compactionIndex = variant.count - COMPACTION_WINDOW
  if (!compaction || !summary || !tailFirst)
    throw new Error(`${variant.key} returned too few messages to verify`)
  if (compaction.info.id !== messageID(variant.key, compactionIndex))
    throw new Error(`${variant.key} did not lead with the compaction trigger`)
  if (!compaction.parts.some((part) => part.type === "compaction"))
    throw new Error(`${variant.key} compaction trigger lost its compaction part`)
  if (summary.info.role !== "assistant" || !summary.info.summary || summary.parts.every((part) => part.type !== "text"))
    throw new Error(`${variant.key} lost its usable summary`)
  if (tailFirst.info.id !== messageID(variant.key, compactionIndex - TAIL_START_OFFSET))
    throw new Error(`${variant.key} did not keep the retained tail after the summary`)
}

function runOnce(variant: Variant) {
  const memoryBefore = process.memoryUsage()
  const start = performance.now()
  const output = readCompacted(variant)
  const milliseconds = performance.now() - start
  if (output.length !== variant.expected)
    throw new Error(`${variant.key} returned ${output.length} messages, expected ${variant.expected}`)
  const memoryAfter = process.memoryUsage()
  return {
    milliseconds,
    messages: output.length,
    memoryGrowthBytes: Math.max(
      0,
      memoryAfter.heapUsed + memoryAfter.external - memoryBefore.heapUsed - memoryBefore.external,
    ),
  }
}

function measure(variant: Variant) {
  verify(variant)
  for (let index = 0; index < WARMUPS; index++) runOnce(variant)
  const samples = []

  for (let index = 0; index < RUNS; index++) {
    Bun.gc(true)
    const sample = runOnce(variant)
    samples.push(sample)
    console.log(
      `bench:budget ${variant.key} run ${index + 1}/${RUNS} ${sample.milliseconds.toFixed(2)}ms ` +
        `(${sample.messages} messages, memory +${sample.memoryGrowthBytes} bytes)`,
    )
  }

  const sorted = samples.toSorted((a, b) => a.milliseconds - b.milliseconds)
  const median = sorted[Math.floor(sorted.length / 2)] ?? { milliseconds: 0, messages: 0, memoryGrowthBytes: 0 }
  return {
    medianMs: median.milliseconds,
    messages: median.messages,
    maxMemoryGrowthBytes: Math.max(...samples.map((sample) => sample.memoryGrowthBytes)),
  }
}

function isBusy(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
}

async function cleanup() {
  for (let attempt = 0; attempt < 30; attempt++) {
    Bun.gc(true)
    await sleep(100)
    const error = await rm(root, { recursive: true, force: true }).then(
      () => undefined,
      (reason) => reason,
    )
    if (error === undefined) return
    if (!isBusy(error)) throw error
  }
  throw new Error(`could not remove benchmark directory after 30 attempts: ${root}`)
}

try {
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: projectID,
        worktree: root,
        vcs: "git",
        time_created: 1,
        time_updated: 1,
        sandboxes: [],
      })
      .run()
  })
  for (const variant of VARIANTS)
    seedSession(SESSIONS.get(variant.key)!, variant.key, variant.count, variant.summary)

  const measured = new Map(VARIANTS.map((variant) => [variant.key, measure(variant)]))
  const small = measured.get("small-valid")!
  const large = measured.get("large-valid")!
  const emptySmall = measured.get("small-empty")!
  const emptyLarge = measured.get("large-empty")!
  const scalingRatio = small.medianMs > 0 ? large.medianMs / small.medianMs : Number.POSITIVE_INFINITY
  const emptyScalingRatio =
    emptySmall.medianMs > 0 ? emptyLarge.medianMs / emptySmall.medianMs : Number.POSITIVE_INFINITY

  console.log(`METRIC filter_compacted_small_median_ms=${small.medianMs.toFixed(2)}`)
  console.log(`METRIC filter_compacted_large_median_ms=${large.medianMs.toFixed(2)}`)
  console.log(`METRIC filter_compacted_scaling_ratio=${scalingRatio.toFixed(2)}`)
  console.log(`METRIC filter_compacted_large_memory_growth_bytes=${large.maxMemoryGrowthBytes}`)
  console.log(`METRIC filter_compacted_empty_small_median_ms=${emptySmall.medianMs.toFixed(2)}`)
  console.log(`METRIC filter_compacted_empty_large_median_ms=${emptyLarge.medianMs.toFixed(2)}`)
  console.log(`METRIC filter_compacted_empty_scaling_ratio=${emptyScalingRatio.toFixed(2)}`)
  console.log(`METRIC filter_compacted_empty_large_memory_growth_bytes=${emptyLarge.maxMemoryGrowthBytes}`)
  console.log("BASELINE filter_compacted_empty_* guards magnitude only; not a cross-machine target")
  console.log(`BUDGET filter_compacted_large_median_ms<=${MAX_LARGE_MEDIAN_MS}`)
  console.log(`BUDGET filter_compacted_scaling_ratio<=${MAX_SCALING_RATIO}`)
  console.log(`BUDGET filter_compacted_large_memory_growth_bytes<=${MAX_LARGE_MEMORY_GROWTH_BYTES}`)
  console.log(`BUDGET filter_compacted_empty_large_median_ms<=${MAX_EMPTY_LARGE_MEDIAN_MS}`)
  const evaluation = evaluateBudgets(
    {
      largeMedianMs: large.medianMs,
      scalingRatio,
      largeMemoryGrowthBytes: large.maxMemoryGrowthBytes,
      emptyLargeMedianMs: emptyLarge.medianMs,
    },
    {
      largeMedianMs: MAX_LARGE_MEDIAN_MS,
      scalingRatio: MAX_SCALING_RATIO,
      largeMemoryGrowthBytes: MAX_LARGE_MEMORY_GROWTH_BYTES,
      emptyLargeMedianMs: MAX_EMPTY_LARGE_MEDIAN_MS,
    },
  )
  for (const violation of evaluation.violations) console.error(`BUDGET VIOLATION ${violation}`)
  if (!evaluation.passed) {
    console.error("bench:budget failed")
    process.exitCode = 1
  }

} finally {
  Database.close()
  await cleanup()
}
