import type { Hooks, PluginInput } from "@redcode-ai/plugin"

/**
 * Dangerous shell command patterns — blocks destructive operations.
 *
 * Fail-open: if checking errors, the command proceeds.
 */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // Root filesystem deletion
  {
    pattern: /\brm\s+(-rf|-[a-zA-Z]*rf[a-zA-Z]*|--recursive\s+--force)\s+(--no-preserve-root\s+)?\/\b/,
    reason: "Attempted to delete root filesystem",
  },
  {
    pattern: /\brm\s+(-rf|-[a-zA-Z]*rf[a-zA-Z]*)\s+--no-preserve-root\b/,
    reason: "Attempted to bypass root filesystem protection",
  },

  // Direct disk writes
  { pattern: /\bdd\s+if=\/dev\/zero\s+of=\/dev\/(sd|nvme|vd|hd|xvd)/, reason: "Attempted direct disk write" },
  { pattern: /\bmkfs\.\w+\s+\/dev\//, reason: "Attempted filesystem creation on device" },
  { pattern: /\bfdisk\s+\/dev\//, reason: "Attempted disk partition modification" },
  { pattern: /\bmkswap\s+\/dev\//, reason: "Attempted swap partition creation" },

  // Fork bomb
  { pattern: /:\(\)\s*\{/, reason: "Attempted fork bomb" },

  // System commands
  { pattern: /\bshutdown\b/, reason: "System shutdown is not allowed" },
  { pattern: /\breboot\b/, reason: "System reboot is not allowed" },
  { pattern: /\bpoweroff\b/, reason: "System poweroff is not allowed" },
  { pattern: /\bhalt\b/, reason: "System halt is not allowed" },
]

function isDangerous(command: string): { dangerous: true; reason: string } | { dangerous: false } {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return { dangerous: true, reason }
  }
  return { dangerous: false }
}

export async function SafeShellPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "tool.use.pre": async (input, output) => {
      if (input.tool !== "bash") return
      const command = (input.args as Record<string, unknown>)?.command
      if (typeof command !== "string" || !command.trim()) return

      const check = isDangerous(command)
      if (check.dangerous) {
        output.denied = true
        output.reason = check.reason
      }
    },
  }
}
