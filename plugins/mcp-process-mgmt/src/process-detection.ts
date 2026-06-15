// REPL and process state detection — adapted from DesktopCommanderMCP

export interface ProcessState {
  isWaitingForInput: boolean
  isFinished: boolean
  isRunning: boolean
  detectedPrompt?: string
}

const REPL_PROMPTS: Record<string, string[]> = {
  python: [">>> ", "... "],
  node: ["> ", "... "],
  shell: ["$ ", "# ", "% ", "bash-", "zsh-"],
  mysql: ["mysql> ", "    -> "],
  postgres: ["=# ", "-# "],
  redis: ["redis> "],
}

const ERROR_COMPLETION_PATTERNS = [
  /Error:/i,
  /Exception:/i,
  /Traceback/i,
  /SyntaxError/i,
  /Uncaught/i,
]

export function analyzeProcessState(output: string): ProcessState {
  if (!output || output.trim().length === 0) {
    return { isWaitingForInput: false, isFinished: false, isRunning: true }
  }

  const lines = output.split("\n")
  const lastLine = lines[lines.length - 1] || ""

  // Check for REPL prompts
  const allPrompts = Object.values(REPL_PROMPTS).flat()
  const detectedPrompt = allPrompts.find((p) => lastLine.endsWith(p) || lastLine.includes(p))

  if (detectedPrompt) {
    return { isWaitingForInput: true, isFinished: false, isRunning: true, detectedPrompt }
  }

  // Check for error patterns
  const hasError = ERROR_COMPLETION_PATTERNS.some((p) => p.test(lastLine))
  if (hasError) {
    return { isWaitingForInput: false, isFinished: true, isRunning: false }
  }

  return { isWaitingForInput: false, isFinished: false, isRunning: true }
}

export function cleanProcessOutput(output: string, inputSent?: string): string {
  let cleaned = output

  if (inputSent) {
    const inputLines = inputSent.split("\n")
    for (const line of inputLines) {
      if (line.trim()) {
        cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(line.trim())}\\s*\n?`, "m"), "")
      }
    }
  }

  // Remove common prompts
  cleaned = cleaned.replace(/^>>>\s*/gm, "")
  cleaned = cleaned.replace(/^>\s*/gm, "")
  cleaned = cleaned.replace(/^\.{3}\s*/gm, "")
  cleaned = cleaned.replace(/\n>>>\s*$/, "")
  cleaned = cleaned.replace(/\n>\s*$/, "")

  return cleaned.trim()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
