// 260629 Red canary token for prompt-injection detection.
// A per-session random string injected into the system prompt as an
// unremarkable "Session marker" line. If it ever appears in model output
// (assistant text or tool-call arguments), the session is terminated.

const store = new Map<string, string>()

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
