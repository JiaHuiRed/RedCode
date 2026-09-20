import { Option, Schema } from "effect"
import { createHash } from "node:crypto"
import type { ChildCapability, ChildProfile } from "./capability"

const nonEmpty = (value: string) => value.trim().length > 0

export const TaskPacketSchema = Schema.Struct({
  version: Schema.Literal(1),
  goal: Schema.String,
  profile: Schema.Literals(["explore", "execute"]),
  scope: Schema.Struct({
    directories: Schema.Array(Schema.String),
    files: Schema.Array(Schema.String),
  }),
  constraints: Schema.Array(Schema.String),
  acceptance: Schema.Array(Schema.String),
  verification: Schema.Array(Schema.String),
  return: Schema.String,
})

export type TaskPacket = Schema.Schema.Type<typeof TaskPacketSchema>

export function compileExploreTaskPacket(input: { goal: string; directory: string }): TaskPacket | undefined {
  return decodeTaskPacket({
    version: 1,
    goal: input.goal,
    profile: "explore",
    scope: {
      directories: [input.directory],
      files: [],
    },
    constraints: [
      "Do not modify files, run shell commands, delegate tasks, commit, or push.",
      "Treat unknown MCP tools as unavailable.",
    ],
    acceptance: ["Return evidence and file references for the requested investigation."],
    verification: ["Confirm the reported findings against the current source tree."],
    return: "Return a bounded evidence-backed report without claiming overall completion.",
  })
}

export function decodeTaskPacket(input: unknown): TaskPacket | undefined {
  const packet = Option.getOrUndefined(Schema.decodeUnknownOption(TaskPacketSchema)(input))
  if (!packet) return undefined
  if (!nonEmpty(packet.goal) || !nonEmpty(packet.return)) return undefined
  if (packet.scope.directories.length === 0 && packet.scope.files.length === 0) return undefined
  if (packet.acceptance.length === 0 || packet.verification.length === 0) return undefined
  return packet
}

export const ResultStatus = Schema.Literals(["ready_for_review", "blocked", "failed", "uncertain", "cancelled"])
export type ResultStatus = Schema.Schema.Type<typeof ResultStatus>

export const ResultPacketSchema = Schema.Struct({
  status: ResultStatus,
  summary: Schema.String,
  requestedScope: Schema.Array(Schema.String),
  uncertainties: Schema.Array(Schema.String),
  changedFiles: Schema.Array(Schema.String),
  verification: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      status: Schema.Literals(["passed", "failed", "timed_out", "not_run"]),
      output: Schema.String,
    }),
  ),
  toolCalls: Schema.optional(Schema.Number),
  elapsedMs: Schema.Number,
  termination: Schema.Literals(["normal", "cancelled", "timeout", "scope_denied", "persistence_failed"]),
})

export type ResultPacket = Schema.Schema.Type<typeof ResultPacketSchema>

export function createChildResultPacket(input: {
  packet: TaskPacket
  status: ResultStatus
  summary: string
  elapsedMs: number
  termination: ResultPacket["termination"]
}): ResultPacket {
  return {
    status: input.status,
    summary: input.summary,
    requestedScope: [...input.packet.scope.directories, ...input.packet.scope.files],
    uncertainties: ["Runtime did not independently execute Task Packet verification."],
    changedFiles: [],
    verification: input.packet.verification.map((command) => ({
      command,
      status: "not_run" as const,
      output: "",
    })),
    elapsedMs: input.elapsedMs,
    termination: input.termination,
  }
}

export const MAX_MAIN_PROJECTION_BYTES = 32 * 1024

export function boundedResultProjection(result: ResultPacket): {
  text: string
  truncated: boolean
  originalBytes: number
} {
  const original = JSON.stringify(result)
  const originalBytes = new TextEncoder().encode(original).byteLength
  if (originalBytes <= MAX_MAIN_PROJECTION_BYTES) {
    return { text: original, truncated: false, originalBytes }
  }

  const compact = (summary: string) =>
    JSON.stringify({
      status: result.status,
      summary,
      requestedScope: result.requestedScope.slice(0, 16).map((item) => item.slice(0, 256)),
      uncertainties: result.uncertainties.slice(0, 16).map((item) => item.slice(0, 256)),
      changedFiles: result.changedFiles.slice(0, 64).map((item) => item.slice(0, 256)),
      verification: result.verification.slice(0, 16).map((item) => ({
        command: item.command.slice(0, 256),
        status: item.status,
        output: item.output.slice(0, 512),
      })),
      toolCalls: result.toolCalls,
      elapsedMs: result.elapsedMs,
      termination: result.termination,
      truncated: true,
      originalBytes,
    })

  let low = 0
  let high = result.summary.length
  let text = compact("")
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = compact(result.summary.slice(0, middle))
    if (new TextEncoder().encode(candidate).byteLength <= MAX_MAIN_PROJECTION_BYTES) {
      text = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (new TextEncoder().encode(text).byteLength > MAX_MAIN_PROJECTION_BYTES) {
    text = JSON.stringify({
      status: result.status,
      summary: "",
      termination: result.termination,
      truncated: true,
      originalBytes,
    })
  }
  return {
    text,
    truncated: true,
    originalBytes,
  }
}

export function boundedTaskText(text: string): string {
  return boundedResultProjection({
    status: "ready_for_review",
    summary: text,
    requestedScope: [],
    uncertainties: [],
    changedFiles: [],
    verification: [],
    elapsedMs: 0,
    termination: "normal",
  }).text
}

export type ChildTaskRecord = {
  version: 1
  taskID: string
  parentSessionID: string
  childSessionID: string
  packet: TaskPacket
  capabilities: ReadonlyArray<ChildCapability>
  profile: ChildProfile
  packetHash: string
  createdAt: number
  result?: ResultPacket
}

export function createChildTaskRecord(input: {
  taskID: string
  parentSessionID: string
  childSessionID: string
  packet: TaskPacket
  capabilities: ReadonlyArray<ChildCapability>
  profile: ChildProfile
  createdAt: number
}): ChildTaskRecord {
  return {
    version: 1,
    taskID: input.taskID,
    parentSessionID: input.parentSessionID,
    childSessionID: input.childSessionID,
    packet: input.packet,
    capabilities: [...input.capabilities],
    profile: input.profile,
    packetHash: createHash("sha256").update(JSON.stringify(input.packet)).digest("hex"),
    createdAt: input.createdAt,
  }
}
