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

// 261107 Red D3（docs/agent-dispatch-plan.md）：删除运行时永远采集不到的占位字段
// （changedFiles 恒 []、verification 全部伪造 not_run、toolCalls 从未上报）——落盘
// 假数据会误导后续审计，宁可没有；未核验事实靠 uncertainties 的诚实声明与父线程复核。
export const ResultPacketSchema = Schema.Struct({
  status: ResultStatus,
  summary: Schema.String,
  requestedScope: Schema.Array(Schema.String),
  uncertainties: Schema.Array(Schema.String),
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
    elapsedMs: input.elapsedMs,
    termination: input.termination,
  }
}

export const MAX_MAIN_PROJECTION_BYTES = 32 * 1024

// 261107 Red D3：explore 结果投影从「ResultPacket JSON 信封」改纯文本——信封 6 个恒空/
// 样板字段每次派发都白付 token，报告埋在 summary 字符串里还吃转义开销；原 JSON 信封
// 投影机（boundedResultProjection）随之删除。字节帽保留，截断走字节边界并预留尾部标注。
const TRUNCATION_RESERVE_BYTES = 128

export function boundedTaskText(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= MAX_MAIN_PROJECTION_BYTES) return text
  let end = MAX_MAIN_PROJECTION_BYTES - TRUNCATION_RESERVE_BYTES
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  const detail = `[truncated: showing first ${end} of ${bytes.byteLength} bytes]`
  return new TextDecoder().decode(bytes.slice(0, end)) + `\n${detail}`
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
