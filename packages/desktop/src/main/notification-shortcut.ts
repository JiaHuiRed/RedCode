import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { join, resolve } from "node:path"

// 260930 Red Windows notification shortcut identity and safe Electron.lnk backup; see docs/notes/implemented/bug-fix/2026-09-30-session-notification-delivery.md.
export type ShortcutDetails = {
  target?: string
  args?: string
  cwd?: string
  description?: string
  icon?: string
  iconIndex?: number
  appUserModelId?: string
}

type ShortcutShell = {
  readShortcutLink: (path: string) => ShortcutDetails
  writeShortcutLink: (
    path: string,
    operation: "create" | "update",
    details: ShortcutDetails & { target: string },
  ) => boolean
}

type Logger = {
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

type Options = {
  platform: string
  packaged: boolean
  appUserModelId: string
  packagedAppUserModelId: string
  displayName: string
  startMenuProgramsPath: string
  userDataPath: string
  execPath: string
  appPath?: string
  appArguments: string[]
  cwd: string
  iconPath: string
  shell: ShortcutShell
  logger: Logger
  backupId?: () => string
}

function quoteWindowsArgument(value: string) {
  if (value.length > 0 && !/[ \t"]/u.test(value)) return value

  let result = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1
      continue
    }
    if (character === '"') {
      result += `${"\\".repeat(backslashes * 2 + 1)}"`
      backslashes = 0
      continue
    }
    result += `${"\\".repeat(backslashes)}${character}`
    backslashes = 0
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`
}

function parseWindowsArguments(commandLine: string) {
  const args: string[] = []
  let current = ""
  let quoted = false
  let started = false

  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine[index]!
    if (character === "\\") {
      let end = index
      while (commandLine[end] === "\\") end += 1
      const count = end - index
      if (commandLine[end] === '"') {
        current += "\\".repeat(Math.floor(count / 2))
        started = true
        if (count % 2 === 1) current += '"'
        else quoted = !quoted
        index = end
        continue
      }
      current += "\\".repeat(count)
      started = true
      index = end - 1
      continue
    }
    if (character === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (/\s/u.test(character) && !quoted) {
      if (started) args.push(current)
      current = ""
      started = false
      continue
    }
    current += character
    started = true
  }

  if (started) args.push(current)
  return args
}

function joinWindowsArguments(args: string[]) {
  return args.map(quoteWindowsArgument).join(" ")
}

function samePath(left: string | undefined, right: string) {
  return left !== undefined && resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

function backupPath(directory: string, nextId: () => string) {
  const id = nextId()
  let suffix = 0
  let candidate: string
  do {
    candidate = join(directory, `Electron-${id}${suffix ? `-${suffix}` : ""}.lnk`)
    suffix += 1
  } while (existsSync(candidate))
  return candidate
}

function migrateConflictingElectronShortcut(options: Options) {
  const oldPath = join(options.startMenuProgramsPath, "Electron.lnk")
  if (!existsSync(oldPath)) return

  let oldShortcut: ShortcutDetails
  try {
    oldShortcut = options.shell.readShortcutLink(oldPath)
  } catch (error) {
    options.logger.warn("failed to inspect Electron notification shortcut", { oldPath, error: String(error) })
    return
  }

  const isElectronTarget = oldShortcut.target?.split(/[\\/]/u).at(-1)?.toLowerCase() === "electron.exe"
  if (
    oldShortcut.appUserModelId !== options.packagedAppUserModelId ||
    !isElectronTarget ||
    (oldShortcut.args ?? "").trim() !== ""
  ) {
    return
  }

  const backupDirectory = join(options.userDataPath, "shortcut-backups")
  const nextId = options.backupId ?? randomUUID
  const destination = backupPath(backupDirectory, nextId)
  try {
    mkdirSync(backupDirectory, { recursive: true })
    renameSync(oldPath, destination)
    options.logger.log("migrated conflicting Electron notification shortcut", { oldPath, destination })
  } catch (error) {
    options.logger.warn("failed to back up conflicting Electron notification shortcut", {
      oldPath,
      destination,
      error: String(error),
    })
  }
}

export function ensureNotificationShortcut(options: Options) {
  if (options.platform !== "win32") return
  if (!options.packaged && !options.appPath) {
    options.logger.warn("failed to write dev notification shortcut", { error: "missing app path" })
    return
  }

  const shortcutPath = join(
    options.startMenuProgramsPath,
    options.packaged ? `${options.displayName}.lnk` : "RedCode Dev (dev).lnk",
  )
  let previousShortcut: ShortcutDetails | undefined
  if (existsSync(shortcutPath)) {
    try {
      previousShortcut = options.shell.readShortcutLink(shortcutPath)
    } catch (error) {
      options.logger.warn("failed to inspect existing notification shortcut", {
        shortcutPath,
        error: String(error),
      })
    }
  }

  const pointsToCurrentExecPath = samePath(previousShortcut?.target, options.execPath)
  const previousDevArguments =
    pointsToCurrentExecPath && previousShortcut?.args ? parseWindowsArguments(previousShortcut.args) : []
  const devArgs =
    options.packaged || !options.appPath
      ? ""
      : joinWindowsArguments([
          resolve(options.appPath),
          ...(previousDevArguments.length > 0
            ? previousDevArguments[0]!.startsWith("-")
              ? previousDevArguments
              : previousDevArguments.slice(1)
            : options.appArguments),
        ])
  const details = {
    target: options.execPath,
    args: options.packaged ? (pointsToCurrentExecPath ? (previousShortcut?.args ?? "") : "") : devArgs,
    cwd: options.cwd,
    icon: options.iconPath,
    iconIndex: 0,
    description: options.packaged ? options.displayName : `${options.displayName} (development)`,
    appUserModelId: options.appUserModelId,
  }

  let written: boolean
  try {
    written = options.shell.writeShortcutLink(shortcutPath, existsSync(shortcutPath) ? "update" : "create", details)
  } catch (error) {
    options.logger.warn("failed to write notification shortcut", { shortcutPath, error: String(error) })
    return
  }
  if (!written) {
    options.logger.warn("failed to write notification shortcut", {
      shortcutPath,
      error: "writeShortcutLink returned false",
    })
    return
  }

  options.logger.log("notification shortcut written", { shortcutPath, aumid: options.appUserModelId })
  if (options.packaged) migrateConflictingElectronShortcut(options)
}
