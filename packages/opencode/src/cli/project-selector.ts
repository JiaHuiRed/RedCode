import path from "path"
import { Database } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"
import { Style } from "./ui"

interface ProjectEntry {
  worktree: string
  name: string
}

const { TEXT_HIGHLIGHT_BOLD, TEXT_DIM, TEXT_NORMAL, TEXT_WARNING, TEXT_SUCCESS } = Style

function loadProjects(): ProjectEntry[] {
  try {
    return Database.use((db) => {
      const rows = (db as typeof db).select().from(ProjectTable).all() as Array<{
        worktree: string
        name: string | null
      }>
      return rows
        .filter((r) => r.worktree && !r.worktree.includes("redcode-test"))
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

  const items: ProjectEntry[] = [currentEntry, ...allProjects]
  if (items.length <= 1) return undefined

  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()
  stdout.write("\x1b[?25l")

  let filter = ""
  let selected = 0
  let renderedLines = 0
  let cleanupDone = false

  const cleanup = () => {
    if (cleanupDone) return
    cleanupDone = true
    stdin.removeAllListeners("data")
    stdout.write("\x1b[?25h")
    if (renderedLines > 0) stdout.write("\x1b[" + renderedLines + "A\x1b[J")
    try { stdin.setRawMode(wasRaw) } catch {}
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

    let content = ""

    // Title
    content += "\n"
    content += TEXT_HIGHLIGHT_BOLD + "  Select a workspace" + TEXT_NORMAL + "\n\n"

    // Filter
    const filterPrompt = filter
      ? "  " + TEXT_WARNING + "🔍" + TEXT_NORMAL + " " + filter
      : "  " + TEXT_DIM + "  type to filter projects…" + TEXT_NORMAL
    content += filterPrompt + "\n\n"

    // List
    const visible = filtered.slice(scrollOffset, scrollOffset + maxVisible)
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]!
      const isSel = i + scrollOffset === selected
      const prefix = isSel ? "  " + TEXT_SUCCESS + "▸" + TEXT_NORMAL + " " : "    "
      const label = isSel ? TEXT_NORMAL + entry.name : TEXT_DIM + entry.name
      const w = truncate(entry.worktree, 50)

      content += prefix + label + "\n"
      if (isSel) {
        content += "     " + TEXT_DIM + w + TEXT_NORMAL + "\n"
      }
    }

    // Footer
    content += "\n" + TEXT_DIM + "  ↑↓ navigate · type filter · Enter select · Esc cancel" + TEXT_NORMAL + "\n"

    if (renderedLines > 0) {
      stdout.write("\x1b[" + renderedLines + "A\x1b[J")
    } else {
      stdout.write("\x1b[J")
    }
    stdout.write(content)
    renderedLines = content.split("\n").length
  }

  return new Promise<string | undefined>((resolve) => {
    render()

    stdin.on("data", (data: Buffer) => {
      if (cleanupDone) return
      const key = data.toString()

      // Enter
      if (key === "\r" || key === "\n") {
        const filtered = getFiltered()
        const result = filtered.length > 0 ? filtered[selected]?.worktree : undefined
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
