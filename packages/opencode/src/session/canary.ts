// 260629 Red canary token for prompt-injection detection.
// A per-session random string injected into the system prompt as an
// unremarkable "Session marker" line. If it ever appears in model output
// (assistant text or tool-call arguments), the session is terminated.
// 260701 Red use globalThis for store — bun compile may instantiate this module
// multiple times (same root cause as prompt.ts's _caches, fixed 5127c0643/260620).
// A duplicated module-level `const store` starts empty, so get() mints a NEW
// random token for a session that already has one, mutating the injected
// "Session marker" line and breaking DeepSeek prefix cache on that turn.
const store: Map<string, string> = ((globalThis as any).__rc_canary_store ??= new Map<string, string>())

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(buf)
  } else {
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function get(sessionID: string): string {
  let token = store.get(sessionID)
  if (!token) {
    token = `RC-${randomHex(8)}`
    store.set(sessionID, token)
  }
  return token
}

export function check(text: string, sessionID: string): boolean {
  const token = store.get(sessionID)
  if (!token) return false
  return text.toLowerCase().includes(token.toLowerCase())
}

export function clear(sessionID: string): void {
  store.delete(sessionID)
}

export const Canary = {
  get,
  check,
  clear,
}
