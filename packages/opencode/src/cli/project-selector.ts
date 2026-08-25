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

/** 列表视口占掉的固定行数（见 listViewport 的注释）。 */
export const FRAME_ROWS = 9

/**
 * 算出列表能显示几项、从第几项开始。抽成纯函数是为了能单测——
 * 这段算术此前内联在 render() 里，而 render() 需要真终端才能跑。
 *
 * 260825 Red 帧本身要占 7 个固定行（列表上方的 空行/标题/空行/过滤器/空行，
 * 下方的 空行/页脚）加一行选中路径，再留一行富余，好让内容结尾的 "\n" 把光标
 * 停在视口内。帧只要溢出一行，终端就会滚动，buf[0] 离开第 1 行，点击映射
 * （y - 1）就会静默偏移滚动的行数——全屏窗口从不溢出（所以点击一直是准的），
 * 小窗口则偏得厉害。
 *
 * 260825 cc **下限保护**：原先是裸的 `height - FRAME_ROWS`，没有下限。终端只有
 * 9 行时算出 0、8 行时算出 -1，两种情况下 `slice(offset, offset + maxVisible)`
 * 都返回空数组——框架画得出来、**一个工作区都不显示**，而选择器是入口闸，
 * 连「新建路径」那个哨兵项也在列表里、一起消失，用户直接卡死。不崩、不报错，
 * 只是看着像没有工作区。至少留 1 行：宁可让帧溢出（点击映射偏一点、方向键仍
 * 可用），也不能让列表整个消失。
 */
export function listViewport(input: { total: number; selected: number; height: number }): {
  maxVisible: number
  scrollOffset: number
} {
  const room = Math.max(1, input.height - FRAME_ROWS)
  const maxVisible = Math.min(input.total, room)
  const scrollOffset = Math.max(0, Math.min(input.selected - Math.floor(maxVisible / 2), input.total - maxVisible))
  return { maxVisible, scrollOffset }
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
  // 260825 Red mouse support: enable SGR mouse tracking (1000 = button
  // events, 1006 = SGR encoding), then clear the screen and home the cursor
  // so buf[0] always paints at row 1 — a click's y maps to buf line as
  // y - 1. An earlier revision anchored the mapping with a DSR
  // cursor-position reply instead, but under ConPTY that reply is measured
  // against the conpty-side buffer, not the visible viewport, so it drifts
  // against the terminal's mouse coordinates by a variable number of lines
  // (observed 5-8) and clicks landed on the wrong item. Clearing makes the
  // anchor constant; the selector is an ephemeral full-screen UI, so wiping
  // whatever output preceded it costs nothing.
  stdout.write("\x1b[?1000h\x1b[?1006h")
  stdout.write("\x1b[2J\x1b[H")

  let filter = ""
  let selected = 0
  let renderedLines = 0
  let cleanupDone = false
  let scrollOffset = 0
  let itemRows: number[] = []

  // Path input mode state
  let pathInputMode = false
  let pathBuffer = ""
  let pathError = ""
  // 260825 cc 异常退出兜底。cleanup 只在显式路径上跑（Enter/Esc/点击确认，以及按键
  // 处理里接住的 Ctrl+C —— raw mode 下它不会变成 SIGINT，而是当作普通按键送进来，
  // 所以那条路径是安全的）。
  // 但硬崩溃、外部 kill、终端被直接关掉时 cleanup 不会执行，SGR 鼠标追踪就留在了用户
  // 终端里：之后每次点击都往 shell 里喷 \x1b[<0;12;5M。
  // 这里只做最小复位（关鼠标追踪 + 恢复光标），刻意不碰 raw mode 和那段依赖
  // renderedLines 的光标回退——退出路径上重排屏幕比留点脏字节更危险。
  // 只挂 "exit"：它覆盖正常退出、process.exit() 与未捕获异常退出。不挂 SIGTERM/SIGHUP，
  // 因为装上处理器会阻止默认终止行为，得自己补 re-exit，为这点收益不值得担那个风险。
  const restoreTerminal = () => {
    if (cleanupDone) return
    try {
      stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h")
    } catch {}
  }
  process.once("exit", restoreTerminal)

  const cleanup = () => {
    if (cleanupDone) return
    cleanupDone = true
    process.off("exit", restoreTerminal)
    stdin.removeAllListeners("data")
    stdout.write("\x1b[?1000l\x1b[?1006l")
    stdout.write("\x1b[?25h")
    if (renderedLines > 0) stdout.write("\x1b[" + renderedLines + "A\x1b[J")
    try {
      stdin.setRawMode(wasRaw)
    } catch {}
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
    const viewport = listViewport({ total: filtered.length, selected, height })
    const maxVisible = viewport.maxVisible
    scrollOffset = viewport.scrollOffset

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
      itemRows = []
      for (let i = 0; i < visible.length; i++) {
        const entry = visible[i]!
        const isSel = i + scrollOffset === selected
        const prefix = isSel ? "  " + TEXT_SUCCESS + "▸" + TEXT_NORMAL + " " : "    "
        const label = isSel ? TEXT_NORMAL + entry.name : TEXT_DIM + entry.name
        itemRows.push(buf.length)

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
      buf.push(
        TEXT_DIM +
          "  ↑↓/wheel navigate · type filter · click select · click again / Enter open · Esc cancel" +
          TEXT_NORMAL,
      )
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
    // 260825 Red shared by Enter and mouse-click confirm: act on the
    // currently selected entry (open path input for the sentinel, otherwise
    // resolve the worktree).
    const confirmSelected = () => {
      const filtered = getFiltered()
      const entry = filtered.length > 0 ? filtered[selected] : undefined
      if (entry?.worktree === NEW_DIR_SENTINEL) {
        enterPathInput()
        return
      }
      const result = entry?.worktree
      cleanup()
      resolve(result)
    }

    render()

    stdin.on("data", (data: Buffer) => {
      if (cleanupDone) return
      const key = data.toString()
      // 260825 Red SGR mouse: \x1b[<button;x;yM (press) / m (release).
      // Release events are ignored. Wheel (buttons 64/65) needs no absolute
      // row; clicks map y onto itemRows with buf[0] pinned at screen row 1
      // (see the clear-screen at startup). Clicking the already-selected
      // entry confirms it — so double-click = open, single click = select,
      // matching the footer copy.
      const mouse = key.match(/^\x1b\[<(\d+);\d+;(\d+)M$/)
      if (mouse) {
        if (!pathInputMode) {
          const button = parseInt(mouse[1]!)
          const y = parseInt(mouse[2]!)
          if (button === 64 || button === 65) {
            const filtered = getFiltered()
            selected = Math.max(0, Math.min(filtered.length - 1, selected + (button === 64 ? -1 : 1)))
            render()
          } else if (button === 0) {
            const visibleIndex = itemRows.indexOf(y - 1)
            if (visibleIndex >= 0) {
              const idx = scrollOffset + visibleIndex
              if (idx === selected) {
                confirmSelected()
              } else {
                selected = idx
                render()
              }
            }
          }
        }
        return
      }

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
        confirmSelected()
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
        selected = 0
        render()
        return
      }
      if (key === "\x1b[F" || key === "\x1b[4~") {
        const filtered = getFiltered()
        selected = filtered.length - 1
        render()
        return
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        if (filter.length > 0) {
          filter = filter.slice(0, -1)
          selected = 0
        }
        render()
        return
      }

      // Page Up / Page Down
      if (key === "\x1b[5~") {
        const page = Math.floor((stdout.rows ?? 24) / 2)
        selected = Math.max(0, selected - page)
        render()
        return
      }
      if (key === "\x1b[6~") {
        const filtered = getFiltered()
        const page = Math.floor((stdout.rows ?? 24) / 2)
        selected = Math.min(filtered.length - 1, selected + page)
        render()
        return
      }

      // Printable
      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        filter += key
        selected = 0
        render()
        return
      }
    })
  })
}

export * as ProjectSelector from "./project-selector"
