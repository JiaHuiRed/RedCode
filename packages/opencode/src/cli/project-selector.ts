import path from "path"
import fs from "fs"
import { Database } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"
import { Style } from "./ui"

const NEW_DIR_SENTINEL = "__new_project_directory__"
const { TEXT_HIGHLIGHT_BOLD, TEXT_DIM, TEXT_NORMAL, TEXT_WARNING, TEXT_SUCCESS, TEXT_DANGER } = Style

interface ProjectEntry {
  worktree: string
  name: string
}

// 260814 Red 同一个 worktree 在 project 表里可以有多行：upsert 按 id 查（project.ts:297），
// 而 id 随目录状态变——有 git 且有提交取根提交哈希，否则回落 path-<sha256>。目录先在无 git
// 时打开、后 git init（实测 attendance/financialcost），或 .git 被删过重建（实测 RedClaw），
// 都会让同一路径换 id 再插一行，旧行没人清，选择器里就并排显示两个同名条目。
// 这里按路径去重：选择器返回的是 worktree 路径而非 id，保留哪一行都等价。
function loadProjects(): ProjectEntry[] {
  try {
    return Database.use((db) => {
      const rows = (db as typeof db).select().from(ProjectTable).all() as Array<{
        worktree: string
        name: string | null
      }>
      const seen = new Set<string>()
      return rows
        .filter((r) => r.worktree && !r.worktree.includes("redcode-test"))
        .filter((r) => {
          const key = path.resolve(r.worktree).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .map((r) => ({ worktree: r.worktree, name: r.name || path.basename(r.worktree) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    })
  } catch {
    return []
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return "…" + str.slice(-(max - 1))
}

/**
 * Show an interactive project selector at startup.
 * Returns the selected worktree path, or `undefined` if cancelled / no projects.
 */
export async function selectProjectInteractive(): Promise<string | undefined> {
  const stdin = process.stdin
  const stdout = process.stdout

  if (!stdin.isTTY || !stdout.isTTY) return undefined

  const allProjects = loadProjects()
  const currentDir = process.cwd()
  const currentEntry: ProjectEntry = {
    worktree: currentDir,
    name: "↳ " + path.basename(currentDir) + " (current)",
  }

  const items: ProjectEntry[] = [
    currentEntry,
    ...allProjects,
    { worktree: NEW_DIR_SENTINEL, name: "Open a different directory..." },
  ]
  if (items.length <= 1) return undefined

  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()
  stdout.write("\x1b[?25l")

  let filter = ""
  let selected = 0
  let renderedLines = 0
  let cleanupDone = false

  // Path input mode state
  let pathInputMode = false
  let pathBuffer = ""
  let pathError = ""

  const cleanup = () => {
    if (cleanupDone) return
    cleanupDone = true
    stdin.removeAllListeners("data")
    stdout.write("\x1b[?25h")
    if (renderedLines > 0) stdout.write("\x1b[" + renderedLines + "A\x1b[J")
    try { stdin.setRawMode(wasRaw) } catch {}
    // Discard any bytes buffered during the selector's lifetime (stray
    // keystrokes, or a terminal capability-query reply in flight) so they
    // don't leak into the next stdin reader — the main TUI's own capability
    // negotiation, which would otherwise misparse them.
    let leftover
    while ((leftover = stdin.read()) !== null) {}
    stdin.pause()
  }

  const getFiltered = (): ProjectEntry[] => {
    if (!filter) return items
    const q = filter.toLowerCase()
    return items.filter((e) => e.name.toLowerCase().includes(q) || e.worktree.toLowerCase().includes(q))
  }

  const render = () => {
    const filtered = getFiltered()
    if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1)
    if (selected < 0) selected = 0

    const height = stdout.rows ?? 24
    const maxVisible = Math.min(filtered.length, height - 6)
    const scrollOffset = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), filtered.length - maxVisible))

    const buf: string[] = []

    // Title
    buf.push("")
    buf.push(TEXT_HIGHLIGHT_BOLD + "  Select a workspace" + TEXT_NORMAL)
    buf.push("")

    if (pathInputMode) {
      // Path input UI
      const cursor = pathBuffer.length ? "" : TEXT_DIM
      const prefix = "  " + TEXT_WARNING + "📁" + TEXT_NORMAL + " "
      buf.push(prefix + cursor + pathBuffer + TEXT_NORMAL + "█")
      if (pathError) {
        buf.push("  " + TEXT_DANGER + pathError + TEXT_NORMAL)
        buf.push("  " + TEXT_DIM + "Press any key to try again, Esc to cancel" + TEXT_NORMAL)
      } else {
        buf.push("")
        buf.push(TEXT_DIM + "  Enter a directory path  ·  Enter confirm  ·  Esc cancel" + TEXT_NORMAL)
      }
    } else {
      // Filter
      const filterPrompt = filter
        ? "  " + TEXT_WARNING + "🔍" + TEXT_NORMAL + " " + filter
        : "  " + TEXT_DIM + "  type to filter projects…" + TEXT_NORMAL
      buf.push(filterPrompt)
      buf.push("")

      // List
      const visible = filtered.slice(scrollOffset, scrollOffset + maxVisible)
      for (let i = 0; i < visible.length; i++) {
        const entry = visible[i]!
        const isSel = i + scrollOffset === selected
        const prefix = isSel ? "  " + TEXT_SUCCESS + "▸" + TEXT_NORMAL + " " : "    "
        const label = isSel ? TEXT_NORMAL + entry.name : TEXT_DIM + entry.name

        if (entry.worktree === NEW_DIR_SENTINEL) {
          buf.push(prefix + label)
        } else {
          const w = truncate(entry.worktree, 50)
          buf.push(prefix + label)
          if (isSel) buf.push("     " + TEXT_DIM + w + TEXT_NORMAL)
        }
      }

      // Footer
      buf.push("")
      buf.push(TEXT_DIM + "  ↑↓ navigate · type filter · Enter select · Esc cancel" + TEXT_NORMAL)
    }

    // buf.join has no trailing separator, unlike the old `content +=`
    // string-building this replaced — every push above ends its own line, so
    // without this the last line is missing its terminating "\n". That threw
    // off `renderedLines` (below) by one, which throws off the next
    // redraw's/cleanup's "\x1b[NA" cursor-up math, corrupting the terminal's
    // cursor state handed off to the main TUI's own capability negotiation
    // right after — see CHANGELOG [0.7.31] follow-up entry.
    const content = buf.join("\n") + "\n"

    if (renderedLines > 0) {
      stdout.write("\x1b[" + renderedLines + "A\x1b[J")
    } else {
      stdout.write("\x1b[J")
    }
    stdout.write(content)
    renderedLines = content.split("\n").length
  }

  return new Promise<string | undefined>((resolve) => {
    const enterPathInput = () => {
      pathInputMode = true
      pathBuffer = ""
      pathError = ""
      selected = 0
      render()
    }

    const submitPath = (): boolean => {
      const resolved = path.resolve(pathBuffer.trim())
      try {
        if (!fs.statSync(resolved).isDirectory()) {
          pathError = "Not a directory: " + resolved
          render()
          return false
        }
      } catch {
        pathError = "Directory not found: " + resolved
        render()
        return false
      }
      cleanup()
      resolve(resolved)
      return true
    }

    render()

    stdin.on("data", (data: Buffer) => {
      if (cleanupDone) return
      const key = data.toString()

      if (pathInputMode) {
        // === Path input mode ===

        // Enter — submit
        if (key === "\r" || key === "\n") {
          if (submitPath()) return
          return
        }

        // Escape — go back to list
        if (key === "\x1b") {
          pathInputMode = false
          pathError = ""
          render()
          return
        }

        // Ctrl+C — cancel
        if (key === "\u0003") {
          cleanup()
          resolve(undefined)
          return
        }

        // Backspace
        if (key === "\x7f" || key === "\b") {
          pathBuffer = pathBuffer.slice(0, -1)
          pathError = ""
          render()
          return
        }

        // Printable, including multi-char bursts from a paste (arrives as one
        // stdin chunk, not one keystroke at a time — a plain length===1 check
        // silently drops it).
        if (key.length >= 1 && !key.startsWith("\x1b")) {
          // oxlint-disable-next-line no-control-regex -- intentional: stripping raw control bytes from pasted text
          const printable = key.replace(/[\x00-\x1f\x7f]/g, "")
          if (printable) {
            pathBuffer += printable
            pathError = ""
            render()
            return
          }
        }

        return
      }

      // === List navigation mode ===

      // Enter
      if (key === "\r" || key === "\n") {
        const filtered = getFiltered()
        const entry = filtered.length > 0 ? filtered[selected] : undefined
        if (entry?.worktree === NEW_DIR_SENTINEL) {
          enterPathInput()
          return
        }
        const result = entry?.worktree
        cleanup()
        resolve(result)
        return
      }

      // Escape / Ctrl+C
      if (key === "\x1b" || key === "\u0003") {
        cleanup()
        resolve(undefined)
        return
      }

      // Up / Down
      if (key === "\x1b[A" || key === "\x1bOA") {
        selected = Math.max(0, selected - 1)
        render()
        return
      }
      if (key === "\x1b[B" || key === "\x1bOB") {
        const filtered = getFiltered()
        selected = Math.min(filtered.length - 1, selected + 1)
        render()
        return
      }

      // Home / End
      if (key === "\x1b[H" || key === "\x1b[1~") {
        selected = 0; render(); return
      }
      if (key === "\x1b[F" || key === "\x1b[4~") {
        const filtered = getFiltered()
        selected = filtered.length - 1; render(); return
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        if (filter.length > 0) { filter = filter.slice(0, -1); selected = 0 }
        render(); return
      }

      // Page Up / Page Down
      if (key === "\x1b[5~") {
        const page = Math.floor((stdout.rows ?? 24) / 2)
        selected = Math.max(0, selected - page); render(); return
      }
      if (key === "\x1b[6~") {
        const filtered = getFiltered()
        const page = Math.floor((stdout.rows ?? 24) / 2)
        selected = Math.min(filtered.length - 1, selected + page); render(); return
      }

      // Printable
      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        filter += key; selected = 0; render(); return
      }
    })
  })
}

export * as ProjectSelector from "./project-selector"
