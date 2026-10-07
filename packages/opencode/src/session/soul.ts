import { Effect } from "effect"
import * as Log from "@redcode-ai/core/util/log"
import { MAX_SOUL_BYTES, type Info } from "@/soul/schema"
import type { Interface as SoulService } from "@/soul"
import { PromptCaches } from "./prompt-caches"

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
  info?: Info
  prompt?: string
  missingWarned: boolean
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
      const info = soulID ? yield* souls.get(soulID) : undefined
      const valid = info && Buffer.byteLength(info.content, "utf8") <= MAX_SOUL_BYTES ? info : undefined
      snapshot = {
        id: soulID ?? "",
        info: valid,
        prompt: valid
          ? render(valid).prompt
          : `# Session identity\n${soulID ? `The pinned Soul "${boundedLabel(soulID)}" is unavailable.` : "No Soul is bound."} Keep the session binding; do not infer identity from client or use another Soul. Use [AI] for commit attribution.`,
        missingWarned: false,
      }
      PromptCaches.souls.set(sessionID, snapshot)
      if (soulID && !valid) {
        log.warn("pinned soul is missing or invalid", { sessionID, soulID })
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
