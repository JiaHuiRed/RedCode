import { readdirSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import * as yaml from "js-yaml"
import { ProfileTypes } from "./types"
import type { RawProfile } from "./types"

const DEFAULT_PROFILE_DIR = path.join(import.meta.dirname, "default")
const decodeProfile = Schema.decodeUnknownSync(ProfileTypes.RawProfile)

/** Load all raw YAML profiles from a directory */
function loadFromDir(dir: string): [string, RawProfile][] {
  const entries: [string, RawProfile][] = []
    try {
      if (!existsSync(dir)) return entries
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue
        try {
          const abs = path.join(dir, file)
          const raw = yaml.load(readFileSync(abs, "utf-8")) as Record<string, unknown> | undefined
          if (!raw || typeof raw !== "object") continue
          const parsed = decodeProfile(raw)
          if (!parsed) continue
          entries.push([parsed.name, parsed])
        } catch {
          // skip malformed file
        }
      }
    } catch {
      // skip inaccessible dir
    }
  return entries
}

/** Load all raw profiles from both default and user directories */
export function loadAll(userDir?: string): [string, RawProfile][] {
  const defaults = loadFromDir(DEFAULT_PROFILE_DIR)
  const user = userDir ? loadFromDir(path.join(userDir, ".opencode", "profiles")) : []
  return [...defaults, ...user]
}

export * as ProfileLoad from "./load"
