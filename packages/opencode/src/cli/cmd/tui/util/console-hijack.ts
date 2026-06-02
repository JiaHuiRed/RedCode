const logs: Array<{ type: "log" | "warn" | "error"; args: unknown[] }> = []
const maxLogs = 500

type ConsoleFn = (...args: unknown[]) => void

let original: {
  log: ConsoleFn
  warn: ConsoleFn
  error: ConsoleFn
} | null = null

export function hijack() {
  if (original) return

  original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }

  // 260602 Red Console劫持：保护TUI渲染
  console.log = (...args: unknown[]) => {
    logs.push({ type: "log", args })
    if (logs.length > maxLogs) logs.shift()
  }

  console.warn = (...args: unknown[]) => {
    logs.push({ type: "warn", args })
    if (logs.length > maxLogs) logs.shift()
  }

  console.error = (...args: unknown[]) => {
    logs.push({ type: "error", args })
    if (logs.length > maxLogs) logs.shift()
  }
}

export function restore() {
  if (!original) return

  console.log = original.log
  console.warn = original.warn
  console.error = original.error
  original = null
}

export function flush() {
  const snapshot = logs.splice(0)
  if (original) {
    for (const entry of snapshot) {
      original[entry.type](`[TUI]`, ...entry.args)
    }
  }
}

export function getLogs() {
  return [...logs]
}
