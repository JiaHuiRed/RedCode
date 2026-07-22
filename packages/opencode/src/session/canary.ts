// 260629 Red canary token for prompt-injection detection.
// A per-session marker injected into the system prompt with an explicit
// "never repeat this" instruction (see session/prompt.ts). If it ever
// appears in model output (assistant text or tool-call arguments), the
// session is terminated.
// 260708 Red token is now DETERMINISTICALLY derived from a persistent secret +
// sessionID (hmac), so it stays identical across server restarts. The old
// random-per-mint token lived only in process memory: home's local server
// reconnect/restart wiped it → next turn minted a NEW token → the injected
// "Session marker" line changed → provider prefix cache for the whole history
// was invalidated → full re-prefill every turn (slow first token). Deriving the
// token removes that instability while keeping the leak check intact.
import { Global } from "@redcode-ai/core/global"
import { createHmac } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(buf)
  } else {
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

// Persistent, machine-unique secret: generated once, read back on every start,
// so derived tokens are stable across restarts yet unpredictable to outsiders.
function loadSecret(): string {
  const override = process.env["REDCODE_CANARY_SECRET"]
  if (override) return override
  const file = path.join(Global.Path.state, "canary-secret")
  try {
    const existing = fs.readFileSync(file, "utf8").trim()
    if (existing) return existing
  } catch {}
  const secret = randomHex(32)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, secret, "utf8")
  } catch {}
  return secret
}

// globalThis-cached: bun compile may instantiate this module more than once;
// all instances must resolve the same secret (disk read is the fallback).
const secret: string = ((globalThis as any).__rc_canary_secret ??= loadSecret())

export function get(sessionID: string): string {
  return `RC-${createHmac("sha256", secret).update(sessionID).digest("hex").slice(0, 16)}`
}

export function check(text: string, sessionID: string): boolean {
  const token = get(sessionID)
  return text.toLowerCase().includes(token.toLowerCase())
}

export const Canary = {
  get,
  check,
}
