import { Schema } from "effect"

export class Info extends Schema.Class<Info>("CompanionInfo")({
  id: Schema.String,
  name: Schema.String,
  soulID: Schema.String,
  directory: Schema.String,
  createdAt: Schema.Number,
  files: Schema.Number,
  warnings: Schema.Array(Schema.String),
  timezone: Schema.String,
}) {}

export class ImportInput extends Schema.Class<ImportInput>("CompanionImportInput")({
  source: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
}) {}

export class ImportResult extends Schema.Class<ImportResult>("CompanionImportResult")({
  profile: Info,
  imported: Schema.Boolean,
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
}) {}

export class Passage extends Schema.Class<Passage>("CompanionPassage")({
  path: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  text: Schema.String,
}) {}

export class SearchResult extends Schema.Class<SearchResult>("CompanionSearchResult")({
  results: Schema.Array(Passage),
  warnings: Schema.Array(Schema.String),
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
  archive: 512 * 1024 * 1024,
  importBytes: 64 * 1024 * 1024,
  importFiles: 4096,
  sourceFile: 8 * 1024 * 1024,
  textFile: 4 * 1024 * 1024,
  bootstrap: 32 * 1024,
  longTerm: 24 * 1024,
  identity: 1024,
  recent: 3 * 1024,
  read: 16 * 1024,
  search: 8 * 1024,
  scan: 8 * 1024 * 1024,
  remember: 8 * 1024,
  diary: 4 * 1024 * 1024,
} as const
