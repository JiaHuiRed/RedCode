import { dlopen, ptr } from "bun:ffi"
import type { ReadStream } from "node:tty"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
  })

let k32: ReturnType<typeof kernel> | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    k32 ??= kernel()
    return true
  } catch {
    return false
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0]!
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Force opentui's wcwidth-based width calculation, explicit-width (CPR)
 * measurement, and hint truecolor support via COLORTERM.
 *
 * On Windows, opentui's terminal-capability query doesn't reliably resolve
 * before the renderer paints when the process is a genuinely fresh console
 * spawn (double-clicking the exe in Explorer, or a brand-new terminal
 * window/tab) — as opposed to a shell command typed into an already-open,
 * already-negotiated terminal session, which doesn't hit this. Not specific
 * to the compiled exe or the workspace-selector startup path; a plain
 * `redcode.exe <dir>` from a fresh window reproduces it too.
 *
 * These three overrides fix static/read-only text (logo, i18n shortcut
 * labels, status bar) and Latin/ASCII input in the interactive prompt
 * textarea. CJK text specifically is still invisible when typed into the
 * textarea (and in the logo's Unicode block-drawing glyphs) even with all
 * three forced — that part reproduces the same way with or without this
 * function and looks like a deeper bug in the native EditBuffer's
 * wide-glyph paint path (distinct from capability negotiation, since every
 * capability we can force has been forced). Not yet root-caused; see
 * CHANGELOG [0.7.31] follow-up entries for the full trail before
 * re-investigating.
 */
export function win32ForceTerminalCapabilities() {
  if (process.platform !== "win32") return
  if (process.env.OPENTUI_FORCE_WCWIDTH === undefined) process.env.OPENTUI_FORCE_WCWIDTH = "1"
  if (process.env.OPENTUI_FORCE_EXPLICIT_WIDTH === undefined) process.env.OPENTUI_FORCE_EXPLICIT_WIDTH = "1"
  if (process.env.COLORTERM === undefined) process.env.COLORTERM = "truecolor"
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  k32!.symbols.FlushConsoleInputBuffer(handle)
}

let unhook: (() => void) | undefined

/**
 * Keep ENABLE_PROCESSED_INPUT disabled.
 *
 * On Windows, Ctrl+C becomes a CTRL_C_EVENT (instead of stdin input) when
 * ENABLE_PROCESSED_INPUT is set. Various runtimes can re-apply console modes
 * (sometimes on a later tick), and the flag is console-global, not per-process.
 *
 * We combine:
 * - A `setRawMode(...)` hook to re-clear after known raw-mode toggles.
 * - A low-frequency poll as a backstop for native/external mode changes.
 */
export function win32InstallCtrlCGuard() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return
  if (unhook) return unhook

  const stdin = process.stdin as ReadStream
  const original = stdin.setRawMode

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
  const initial = buf[0]!

  const enforce = () => {
    if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
    const mode = buf[0]!
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  let wrapped: ReadStream["setRawMode"] | undefined

  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode)
      later()
      return result
    }

    stdin.setRawMode = wrapped
  }

  // Ensure it's cleared immediately too (covers any earlier mode changes).
  later()

  const interval = setInterval(enforce, 100)
  interval.unref()

  let done = false
  unhook = () => {
    if (done) return
    done = true

    clearInterval(interval)
    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original
    }

    k32!.symbols.SetConsoleMode(handle, initial)
    unhook = undefined
  }

  return unhook
}
