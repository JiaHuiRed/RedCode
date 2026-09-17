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
const USER_PAYLOAD = "x".repeat(4_096)

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

function seedSession(sessionID: SessionIDType, sessionKey: string, messageCount: number) {
  const compactionIndex = messageCount - 62
  const tailStartIndex = compactionIndex - 10
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
    }

    db.insert(MessageTable).values(messages).run()
    db.insert(PartTable).values(parts).run()
  })
}

const smallSessionID = SessionID.make("ses_performance_small")
const largeSessionID = SessionID.make("ses_performance_large")

function runOnce(sessionID: SessionIDType) {
  const memoryBefore = process.memoryUsage()
  const start = performance.now()
  const output = Effect.runSync(MessageV2.filterCompactedEffect(sessionID))
  const milliseconds = performance.now() - start
  if (output.length === 0) throw new Error("performance benchmark produced no messages")
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

function measure(sessionID: SessionIDType, label: string) {
  for (let index = 0; index < WARMUPS; index++) runOnce(sessionID)
  const samples = []

  for (let index = 0; index < RUNS; index++) {
    Bun.gc(true)
    const sample = runOnce(sessionID)
    samples.push(sample)
    console.log(
      `bench:budget ${label} run ${index + 1}/${RUNS} ${sample.milliseconds.toFixed(2)}ms ` +
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
  seedSession(smallSessionID, "small", SMALL_MESSAGE_COUNT)
  seedSession(largeSessionID, "large", LARGE_MESSAGE_COUNT)

  const small = measure(smallSessionID, "small")
  const large = measure(largeSessionID, "large")
  const scalingRatio = small.medianMs > 0 ? large.medianMs / small.medianMs : Number.POSITIVE_INFINITY

  console.log(`METRIC filter_compacted_small_median_ms=${small.medianMs.toFixed(2)}`)
  console.log(`METRIC filter_compacted_large_median_ms=${large.medianMs.toFixed(2)}`)
  console.log(`METRIC filter_compacted_scaling_ratio=${scalingRatio.toFixed(2)}`)
  console.log(`METRIC filter_compacted_large_memory_growth_bytes=${large.maxMemoryGrowthBytes}`)
  console.log(`BUDGET filter_compacted_large_median_ms<=${MAX_LARGE_MEDIAN_MS}`)
  console.log(`BUDGET filter_compacted_scaling_ratio<=${MAX_SCALING_RATIO}`)
  console.log(`BUDGET filter_compacted_large_memory_growth_bytes<=${MAX_LARGE_MEMORY_GROWTH_BYTES}`)

  if (
    large.medianMs > MAX_LARGE_MEDIAN_MS ||
    scalingRatio > MAX_SCALING_RATIO ||
    large.maxMemoryGrowthBytes > MAX_LARGE_MEMORY_GROWTH_BYTES
  ) {
    console.error("bench:budget failed")
    process.exitCode = 1
  }
} finally {
  Database.close()
  await cleanup()
}
