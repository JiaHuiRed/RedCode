import { Console, Effect } from "effect"
import { Companion } from "@/companion/companion"
import type { Coverage } from "@/companion/schema"
import { effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"

// 0.19.1 audit F-05: render the import census as a readable checklist. Counts only — never echoes personal text.
function renderCoverage(coverage: InstanceType<typeof Coverage>): string {
  const { jsonl, trajectory, deleted, other, final } = coverage
  return [
    "History import coverage",
    "",
    "Plain JSONL:",
    `  scanned: ${jsonl.scanned}`,
    `  extracted: ${jsonl.extracted}`,
    `  internal tasks excluded: ${jsonl.internalExcluded}`,
    `  no usable text: ${jsonl.noUsableText}`,
    `  parse-failed records: ${jsonl.parseFailedRecords}`,
    "Trajectory:",
    `  scanned: ${trajectory.scanned}`,
    `  not imported: ${trajectory.notImported}`,
    `  reason: ${trajectory.reason}`,
    "Deleted:",
    `  found: ${deleted.found}`,
    `  excluded by default: ${deleted.excluded}`,
    "Other sources:",
    `  deduplicated: ${other.deduplicated}`,
    `  conflicts: ${other.conflicts}`,
    "Final:",
    `  searchable history files: ${final.searchableFiles}`,
    `  searchable human turns: ${final.humanTurns}`,
    `  uncovered sources: ${final.uncoveredSources}`,
  ].join("\n")
}

const list = effectCmd({
  command: "list",
  describe: "list imported Chat companions",
  instance: false,
  builder: (yargs) => yargs.option("json", { type: "boolean", describe: "print profile metadata as JSON" }),
  handler: Effect.fn("Cli.companion.list")(function* (args) {
    const service = yield* Companion.Service
    const profiles = yield* service.list().pipe(Effect.catch((error) => fail(error.message)))
    if (args.json) return yield* Console.log(JSON.stringify(profiles, null, 2))
    if (!profiles.length)
      return yield* Console.log("No companion imported. Use: redcode companion import <OpenClaw directory or ZIP>")
    yield* Console.log(profiles.map((profile) => `${profile.id}\t${profile.name}\t${profile.directory}`).join("\n"))
  }),
})

const importArchive = effectCmd({
  command: "import <source>",
  describe: "import an existing OpenClaw companion directory or ZIP",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("source", { type: "string", demandOption: true, describe: "local archive or directory path" })
      .option("id", { type: "string", describe: "stable companion identifier" })
      .option("name", { type: "string", describe: "display name, if the archive does not provide one" })
      .option("json", { type: "boolean", describe: "print the import result as JSON" }),
  handler: Effect.fn("Cli.companion.import")(function* (args) {
    const service = yield* Companion.Service
    const result = yield* service
      .importArchive({ source: args.source, id: args.id, name: args.name })
      .pipe(Effect.catch((error) => fail(error.message)))
    if (args.json) return yield* Console.log(JSON.stringify(result, null, 2))
    yield* Console.log(
      `${result.imported ? "Imported" : "Already imported"}: ${result.profile.name} (${result.profile.id})`,
    )
    yield* Console.log(`Chat: redcode --companion ${result.profile.id}`)
    if (result.coverage) yield* Console.log(`\n${renderCoverage(result.coverage)}`)
    for (const warning of result.profile.warnings) yield* Console.warn(warning)
  }),
})

export const CompanionCommand = cmd({
  command: "companion",
  describe: "import and manage an existing Chat companion",
  builder: (yargs) => yargs.command(list).command(importArchive).demandCommand(),
  handler: () => {},
})
