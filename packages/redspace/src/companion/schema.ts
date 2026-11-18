import { Schema } from "effect"

export const Introduction = Schema.Literals(["available", "active", "paused", "complete"])

export class Info extends Schema.Class<Info>("CompanionInfo")({
  id: Schema.String,
  name: Schema.String,
  soulID: Schema.String,
  directory: Schema.String,
  createdAt: Schema.Number,
  files: Schema.Number,
  warnings: Schema.Array(Schema.String),
  timezone: Schema.String,
  needsSetup: Schema.optional(Schema.Boolean),
  introduction: Schema.optional(Introduction),
}) {}

export function introductionOf(profile: Pick<Info, "introduction" | "needsSetup">) {
  return profile.introduction ?? (profile.needsSetup ? "available" : "complete")
}

export class CreateInput extends Schema.Class<CreateInput>("CompanionCreateInput")({
  requestID: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/))),
}) {}

export class InitializeResult extends Schema.Class<InitializeResult>("CompanionInitializeResult")({
  profile: Info,
  created: Schema.Boolean,
}) {}

export class Details extends Schema.Class<Details>("CompanionDetails")({
  profile: Info,
  user: Schema.String,
  companionName: Schema.String,
  userName: Schema.String,
  paths: Schema.Struct({
    directory: Schema.String,
    user: Schema.String,
    identity: Schema.String,
    memory: Schema.String,
    soul: Schema.String,
  }),
}) {}

export class UpdateInput extends Schema.Class<UpdateInput>("CompanionUpdateInput")({
  name: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  userName: Schema.optional(Schema.String),
  introduction: Schema.optional(Introduction),
}) {}

export class ImportInput extends Schema.Class<ImportInput>("CompanionImportInput")({
  source: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
}) {}

// 0.19.1 audit F-05: a structured census of what an OpenClaw history import scanned,
// extracted and deliberately skipped. Counts only — no personal text ever enters this shape.
// Decision: docs/notes/implemented/feature/2026-11-17-history-import-coverage.md
export class Coverage extends Schema.Class<Coverage>("CompanionCoverage")({
  jsonl: Schema.Struct({
    scanned: Schema.Number,
    extracted: Schema.Number,
    internalExcluded: Schema.Number,
    noUsableText: Schema.Number,
    parseFailedRecords: Schema.Number,
  }),
  trajectory: Schema.Struct({
    scanned: Schema.Number,
    notImported: Schema.Number,
    reason: Schema.String,
  }),
  deleted: Schema.Struct({
    found: Schema.Number,
    excluded: Schema.Number,
  }),
  other: Schema.Struct({
    deduplicated: Schema.Number,
    conflicts: Schema.Number,
  }),
  final: Schema.Struct({
    searchableFiles: Schema.Number,
    humanTurns: Schema.Number,
    uncoveredSources: Schema.Number,
  }),
}) {}

export class ImportResult extends Schema.Class<ImportResult>("CompanionImportResult")({
  profile: Info,
  imported: Schema.Boolean,
  coverage: Schema.optional(Coverage),
}) {}

export class Bootstrap extends Schema.Class<Bootstrap>("CompanionBootstrap")({
  text: Schema.String,
  sources: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
}) {}

export class SearchInput extends Schema.Class<SearchInput>("CompanionSearchInput")({
  id: Schema.String,
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
  paths: Schema.optional(Schema.Array(Schema.String)),
  cursor: Schema.optional(Schema.String),
}) {}

export class Passage extends Schema.Class<Passage>("CompanionPassage")({
  path: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  text: Schema.String,
  byteOffset: Schema.optional(Schema.Number),
}) {}

export class SearchResult extends Schema.Class<SearchResult>("CompanionSearchResult")({
  results: Schema.Array(Passage),
  warnings: Schema.Array(Schema.String),
  nextCursor: Schema.optional(Schema.String),
}) {}

export class ReadInput extends Schema.Class<ReadInput>("CompanionReadInput")({
  id: Schema.String,
  path: Schema.String,
  offset: Schema.optional(Schema.Number),
  byteOffset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
}) {}

export class ReadResult extends Schema.Class<ReadResult>("CompanionReadResult")({
  path: Schema.String,
  text: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  totalLines: Schema.Number,
  truncated: Schema.Boolean,
  byteOffset: Schema.Number,
  nextByteOffset: Schema.optional(Schema.Number),
}) {}

export class RememberInput extends Schema.Class<RememberInput>("CompanionRememberInput")({
  durable: Schema.optional(Schema.Boolean),
  id: Schema.String,
  text: Schema.String,
  source: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  time: Schema.optional(Schema.Number),
}) {}

export class RememberResult extends Schema.Class<RememberResult>("CompanionRememberResult")({
  path: Schema.String,
  created: Schema.Boolean,
}) {}

export class CompanionInvalidInput extends Schema.TaggedError<CompanionInvalidInput>()("CompanionInvalidInput", {
  message: Schema.String,
}) {}

export class CompanionConflict extends Schema.TaggedError<CompanionConflict>()("CompanionConflict", {
  message: Schema.String,
}) {}

export class CompanionNotFound extends Schema.TaggedError<CompanionNotFound>()("CompanionNotFound", {
  message: Schema.String,
}) {}

export class CompanionIO extends Schema.TaggedError<CompanionIO>()("CompanionIO", {
  message: Schema.String,
}) {}

export type Error = CompanionInvalidInput | CompanionConflict | CompanionNotFound | CompanionIO

export const Limits = {
  companions: 2,
  archive: 512 * 1024 * 1024,
  importBytes: 64 * 1024 * 1024,
  importFiles: 4096,
  sourceFile: 8 * 1024 * 1024,
  textFile: 4 * 1024 * 1024,
  bootstrap: 32 * 1024,
  longTerm: 24 * 1024,
  identity: 1024,
  profile: 16 * 1024,
  recent: 3 * 1024,
  read: 16 * 1024,
  search: 8 * 1024,
  scan: 8 * 1024 * 1024,
  remember: 8 * 1024,
  diary: 4 * 1024 * 1024,
} as const
