import { Schema } from "effect"
import DESCRIPTION from "./shell.md" with { type: "text" }
import { PositiveInt } from "@redcode-ai/core/schema"
import { ShellID } from "./id"

const PS = new Set(["powershell", "pwsh"])
const CMD = new Set(["cmd"])

const descriptions = {
  bash: "Describe the command in 5-10 words, e.g. 'Runs focused unit tests'.",
  powershell: "Describe the command in 5-10 words, e.g. 'Checks package types'.",
  cmd: "Describe the command in 5-10 words, e.g. 'Installs package dependencies'.",
}

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema(description: string) {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "The command to execute" }),
    timeout: Schema.optional(PositiveInt).annotate({
      description: "Optional timeout in milliseconds (values above 600000 are clamped to 600000)",
    }),
    workdir: Schema.optional(Schema.String).annotate({
      description:
        "Working directory; defaults to the current directory. Use this instead of changing directories inside the command.",
    }),
    description: Schema.String.annotate({ description }),
  })
}

export const Parameters = parameterSchema(descriptions.bash)
export type Parameters = Schema.Schema.Type<typeof Parameters>

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`)
    return value
  })
}

function shellDisplayName(name: string) {
  if (name === "pwsh") return "PowerShell (7+)"
  if (name === "powershell") return "Windows PowerShell (5.1)"
  if (name === "cmd") return "cmd.exe"
  return name
}

function powershellNotes(name: string) {
  if (name === "pwsh") {
    return `# PowerShell (7+) shell notes
- This shell supports \`&&\` and \`||\`.
- Use double quotes for interpolated strings, single quotes for verbatim strings.
- Prefer full cmdlet names over aliases.
- Use \`$(...)\` for subexpressions and \`@(...)\` for arrays.
- Invoke a native executable with a spaced path using \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick.`
  }
  if (name === "powershell") {
    return `# Windows PowerShell (5.1) shell notes
- Use \`cmd1; if ($?) { cmd2 }\` for dependent commands; this shell does not support \`&&\`.
- Use double quotes for interpolated strings, single quotes for verbatim strings.
- Prefer full cmdlet names over aliases.
- Use \`$(...)\` for subexpressions and \`@(...)\` for arrays.
- Invoke a native executable with a spaced path using \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick.`
  }
  return ""
}

function chainGuidance(name: string) {
  if (name === "powershell")
    return "Use `cmd1; if ($?) { cmd2 }` when later commands depend on earlier success. Use `;` alone only when earlier failure may be ignored."
  if (CMD.has(name))
    return "Use `cmd1 && cmd2` when later commands depend on earlier success. Use `&` alone only when earlier failure may be ignored."
  return "Use `cmd1 && cmd2` when later commands depend on earlier success. Use `;` alone only when earlier failure may be ignored."
}

// 261001 Red Shared workflow belongs to default.md; keep execution details and recovery here.
function outputNotes(limits: Limits) {
  return `# Parameters and output
- Supply \`command\` and a concise 5-10 word \`description\`.
- \`timeout\` is milliseconds: default 120000, maximum 600000 (larger values are clamped).
- Do not separate commands with newlines; quoted multiline strings are allowed.
- Output beyond ${limits.maxLines} lines or ${limits.maxBytes} bytes is truncated automatically and saved in full to a file. Use Read/Grep on that file with suitable offsets/context; do not add pagination or truncation commands.`
}

function bashCommandSection(chain: string, limits: Limits) {
  return `# Execution
- Before a command creates files/directories, verify the intended parent exists with \`ls <parent>\`.
- Quote paths containing spaces, e.g. \`python "path with spaces/script.py"\`.
- ${chain}

${outputNotes(limits)}`
}

function powershellCommandSection(name: string, chain: string, pathSep: string, limits: Limits) {
  return `${powershellNotes(name)}

# Execution
- Before a command creates files/directories, verify the intended parent exists with \`Test-Path -LiteralPath <parent>\`.
- Quote paths containing spaces, e.g. \`& "path with spaces${pathSep}script.ps1"\`.
- ${chain}

${outputNotes(limits)}`
}

function cmdCommandSection(chain: string, limits: Limits) {
  return `# cmd.exe shell notes
- Quote paths containing spaces.
- Use %VAR% for environment variables and \`if exist\` for existence checks.
- Use \`call\` to invoke a batch file from another batch-style command.

# Execution
- Before a command creates files/directories, verify the intended parent exists with \`if exist "parent\\" dir "parent"\`.
- ${chain}

${outputNotes(limits)}`
}

function profile(name: string, platform: NodeJS.Platform, limits: Limits) {
  const isPowerShell = PS.has(name)
  const chain = chainGuidance(name)
  if (CMD.has(name)) {
    return {
      intro: `Executes a ${shellDisplayName(name)} command with an optional timeout.`,
      workdirSection: "Commands default to the current directory. Use `workdir`, not an in-command directory change.",
      commandSection: cmdCommandSection(chain, limits),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction: "Create PR using a temporary body file so cmd.exe quoting stays simple.",
      createPrExample: `(\n  echo ## Summary\n  echo - ^<1-3 bullet points^>\n) > pr-body.txt\ngh pr create --title "the pr title" --body-file pr-body.txt`,
      parameterDescription: descriptions.cmd,
    }
  }
  if (isPowerShell) {
    return {
      intro: `Executes a ${shellDisplayName(name)} command with an optional timeout.`,
      workdirSection: "Commands default to the current directory. Use `workdir`, not an in-command directory change.",
      commandSection: powershellCommandSection(name, chain, platform === "win32" ? "\\" : "/", limits),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction: "Create PR using gh pr create with a PowerShell here-string to pass the body correctly.",
      createPrExample: `gh pr create --title "the pr title" --body @'
## Summary
- <1-3 bullet points>
'@`,
      parameterDescription: descriptions.powershell,
    }
  }
  return {
    intro: "Executes a bash command with an optional timeout.",
    workdirSection: "Commands default to the current directory. Use `workdir`, not an in-command directory change.",
    commandSection: bashCommandSection(chain, limits),
    gitCommands: "bash commands",
    gitCommandRestriction: "git bash commands",
    createPrInstruction:
      "Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.",
    createPrExample: `gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>`,
    parameterDescription: descriptions.bash,
  }
}

export function render(name: string, platform: NodeJS.Platform, limits: Limits, tmpDir: string) {
  const selected = profile(name, platform, limits)
  return {
    description: renderPrompt(DESCRIPTION, {
      intro: selected.intro,
      os: platform,
      shell: name,
      tmp: tmpDir,
      workdirSection: selected.workdirSection,
      commandSection: selected.commandSection,
      gitCommands: selected.gitCommands,
      toolName: ShellID.ToolID,
      gitCommandRestriction: selected.gitCommandRestriction,
      createPrInstruction: selected.createPrInstruction,
      createPrExample: selected.createPrExample,
    }),
    parameters: parameterSchema(selected.parameterDescription),
  }
}

export * as ShellPrompt from "./prompt"
