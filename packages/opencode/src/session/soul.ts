import { Effect } from "effect"
import { createHash } from "node:crypto"
import * as Log from "@redcode-ai/core/util/log"
import { MAX_SOUL_BYTES, type Info } from "@/soul/schema"
import type { Interface as SoulService } from "@/soul"
import { PromptCaches } from "./prompt-caches"
import { Database } from "@/storage/db"
import { SessionTable, SoulVersionTable } from "./session.sql"
import { eq, sql } from "drizzle-orm"

const log = Log.create({ service: "session.soul" })
const MAX_LABEL_BYTES = 256
export const MAX_SOUL_PROMPT_BYTES = MAX_SOUL_BYTES + 1078

function boundedLabel(value: string | undefined) {
  let result = ""
  let size = 0
  for (const char of value?.trim() ?? "") {
    const charSize = Buffer.byteLength(char, "utf8")
    if (size + charSize > MAX_LABEL_BYTES) break
    result += char
    size += charSize
  }
  return result
}

export type Snapshot = {
  id: string
  hash?: string
  info?: Info
  prompt?: string
  missingWarned: boolean
}

export function hashSoul(info: Info) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        info.id,
        boundedLabel(info.name),
        boundedLabel(info.displayName),
        boundedLabel(info.commitPrefix),
        info.content,
      ]),
      "utf8",
    )
    .digest("hex")
}

export function saveSoulVersion(info: Info) {
  if (Buffer.byteLength(info.content, "utf8") > MAX_SOUL_BYTES) return undefined
  const hash = hashSoul(info)
  Database.use((db) =>
    db
      .insert(SoulVersionTable)
      .values({
        hash,
        soul_id: info.id,
        name: boundedLabel(info.name),
        display_name: boundedLabel(info.displayName),
        commit_prefix: boundedLabel(info.commitPrefix),
        body: info.content,
        created_at: Date.now(),
      })
      .onConflictDoNothing()
      .run(),
  )
  return hash
}

export function render(info: Info) {
  const displayName = boundedLabel(info.displayName) || boundedLabel(info.name) || "AI"
  const commitPrefix =
    boundedLabel(info.commitPrefix) || boundedLabel(info.displayName) || boundedLabel(info.name) || "AI"
  return {
    displayName,
    commitPrefix,
    prompt: `# ${displayName} [${commitPrefix}]\n\n${info.content}\n\nIdentity: ${displayName}. Commit attribution owner: [${commitPrefix}].`,
  }
}

export function sessionSoul(sessionID: string, soulID: string | undefined, souls: SoulService) {
  return Effect.gen(function* () {
    let snapshot = PromptCaches.souls.get(sessionID)
    if (!snapshot) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ soul: SessionTable.soul, soul_body_hash: SessionTable.soul_body_hash })
            .from(SessionTable)
            .where(sql`${SessionTable.id} = ${sessionID}`)
            .get(),
        ),
      )
      // 261008 Red 缓存可在调用方检查后回收，冷读必须以持久会话归属为准。
      const pinnedID = row ? row.soul ?? undefined : soulID
      const pinnedHash = row?.soul_body_hash ?? undefined
      const version = pinnedHash
        ? yield* Effect.sync(() =>
            Database.use((db) => db.select().from(SoulVersionTable).where(eq(SoulVersionTable.hash, pinnedHash)).get()),
          )
        : undefined
      const stored = version
        ? {
            id: version.soul_id,
            name: version.name,
            displayName: version.display_name ?? "",
            commitPrefix: version.commit_prefix ?? "",
            path: "",
            content: version.body,
          }
        : undefined
      const versionInfo =
        stored && stored.id === pinnedID && Buffer.byteLength(stored.content, "utf8") <= MAX_SOUL_BYTES &&
        pinnedHash === hashSoul(stored)
          ? stored
          : undefined
      if (pinnedHash && !versionInfo) log.warn("pinned soul version is missing or invalid", { sessionID, soulID: pinnedID, hash: pinnedHash })
      const info = versionInfo ?? (pinnedID ? yield* souls.get(pinnedID) : undefined)
      const valid = info && Buffer.byteLength(info.content, "utf8") <= MAX_SOUL_BYTES ? info : undefined
      snapshot = {
        id: pinnedID ?? "",
        hash: pinnedHash,
        info: valid,
        prompt: valid
          ? render(valid).prompt
          : `# Session identity\n${pinnedID ? `The pinned Soul "${boundedLabel(pinnedID)}" is unavailable.` : "No Soul is bound."} Keep the session binding; do not infer identity from client or use another Soul. Use [AI] for commit attribution.`,
        missingWarned: false,
      }
      PromptCaches.souls.set(sessionID, snapshot)
      if (pinnedID && !valid) {
        log.warn("pinned soul is missing or invalid", { sessionID, soulID: pinnedID })
        snapshot.missingWarned = true
      }
    } else if (snapshot.id && !snapshot.missingWarned && !(yield* souls.get(snapshot.id))) {
      // Keep the original session snapshot: file removal warns, but never changes identity mid-session.
      log.warn("cached pinned soul file is missing or invalid", { sessionID, soulID: snapshot.id })
      snapshot.missingWarned = true
    }
    return snapshot
  })
}

export function sessionTitlePrefix(sessionID: string, soulID: string | undefined, souls: SoulService) {
  return Effect.gen(function* () {
    const snapshot = yield* sessionSoul(sessionID, soulID, souls)
    return snapshot.info ? render(snapshot.info).displayName : "AI"
  })
}
