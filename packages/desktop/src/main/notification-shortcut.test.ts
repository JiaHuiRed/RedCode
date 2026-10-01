import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureNotificationShortcut } from "./notification-shortcut"

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type ShortcutDetails = {
  target?: string
  args?: string
  cwd?: string
  description?: string
  icon?: string
  iconIndex?: number
  appUserModelId?: string
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "redcode-notification-shortcut-"))
  tempRoots.push(root)
  const startMenuProgramsPath = join(root, "Start Menu", "Programs")
  const userDataPath = join(root, "userData")
  mkdirSync(startMenuProgramsPath, { recursive: true })
  mkdirSync(userDataPath, { recursive: true })

  const execPath = join(root, "Application With Spaces", "RedCode Dev.exe")
  const appPath = join(root, "workspace with spaces", "packages", "desktop")
  const details = new Map<string, ShortcutDetails>()
  const events: string[] = []
  const warnings: unknown[][] = []
  let writeResult = true

  const shell = {
    readShortcutLink(path: string) {
      events.push(`read:${path}`)
      const shortcut = details.get(path)
      if (!shortcut) throw new Error(`missing shortcut metadata: ${path}`)
      return shortcut
    },
    writeShortcutLink(path: string, _operation: "create" | "update", shortcut: ShortcutDetails) {
      events.push(`write:${path}`)
      if (!writeResult) return false
      details.set(path, shortcut)
      writeFileSync(path, "replacement")
      return true
    },
  }

  const options = (overrides: Record<string, unknown> = {}) => ({
    platform: "win32",
    packaged: true,
    appUserModelId: "ai.redcode.desktop.dev",
    packagedAppUserModelId: "ai.redcode.desktop.dev",
    displayName: "RedCode Dev",
    startMenuProgramsPath,
    userDataPath,
    execPath,
    appPath,
    appArguments: ["--profile", "custom profile"],
    cwd: root,
    iconPath: join(root, "redcode.ico"),
    shell,
    logger: {
      log: (...args: unknown[]) => events.push(`log:${String(args[0])}`),
      warn: (...args: unknown[]) => warnings.push(args),
    },
    ...overrides,
  })

  return {
    root,
    startMenuProgramsPath,
    userDataPath,
    execPath,
    appPath,
    details,
    events,
    warnings,
    shell,
    options,
    setWriteResult(value: boolean) {
      writeResult = value
    },
    seed(path: string, shortcut: ShortcutDetails, contents = "original") {
      details.set(path, shortcut)
      writeFileSync(path, contents)
    },
  }
}

describe("notification shortcut identity", () => {
  test("writes packaged notification shortcut before migrating only the matching Electron shortcut", () => {
    const f = fixture()
    const oldPath = join(f.startMenuProgramsPath, "Electron.lnk")
    f.seed(
      oldPath,
      {
        target: join(f.root, "node_modules", "electron.exe"),
        args: "",
        appUserModelId: "ai.redcode.desktop.dev",
      },
      "old electron shortcut",
    )

    ensureNotificationShortcut(f.options())

    const replacementPath = join(f.startMenuProgramsPath, "RedCode Dev.lnk")
    const replacement = f.details.get(replacementPath)
    expect(replacement).toMatchObject({
      target: f.execPath,
      args: "",
      icon: join(f.root, "redcode.ico"),
      appUserModelId: "ai.redcode.desktop.dev",
    })
    expect(f.events.findIndex((event) => event.startsWith(`write:${replacementPath}`))).toBeLessThan(
      f.events.findIndex((event) => event.startsWith(`read:${oldPath}`)),
    )
    expect(existsSync(oldPath)).toBe(false)
    const backups = join(f.userDataPath, "shortcut-backups")
    const backup = [...new Bun.Glob("Electron-*.lnk").scanSync({ cwd: backups })].map((name) => join(backups, name))
    expect(backup).toHaveLength(1)
    expect(readFileSync(backup[0]!, "utf8")).toBe("old electron shortcut")
  })

  test("writes unpackaged shortcut with absolute quoted app path and preserves existing app parameters", () => {
    const f = fixture()
    const devPath = join(f.startMenuProgramsPath, "RedCode Dev (dev).lnk")
    f.seed(devPath, {
      target: f.execPath,
      args: `".\\packages\\desktop" --profile "custom profile"`,
    })

    ensureNotificationShortcut(
      f.options({
        packaged: false,
        appUserModelId: "ai.redcode.desktop.dev.unpackaged",
      }),
    )

    expect(f.details.get(devPath)).toMatchObject({
      target: f.execPath,
      args: `"${f.appPath}" --profile "custom profile"`,
      appUserModelId: "ai.redcode.desktop.dev.unpackaged",
      icon: join(f.root, "redcode.ico"),
    })
    expect(existsSync(join(f.startMenuProgramsPath, "Electron.lnk"))).toBe(false)
  })

  test("preserves args when the existing packaged shortcut already targets the current executable", () => {
    const f = fixture()
    const packagedPath = join(f.startMenuProgramsPath, "RedCode Dev.lnk")
    f.seed(packagedPath, {
      target: f.execPath,
      args: "--profile user-profile",
      appUserModelId: "ai.redcode.desktop.dev",
    })

    ensureNotificationShortcut(f.options())

    expect(f.details.get(packagedPath)).toMatchObject({
      target: f.execPath,
      args: "--profile user-profile",
      appUserModelId: "ai.redcode.desktop.dev",
    })
  })

  test.each([
    ["different AUMID", { appUserModelId: "other.app" }],
    ["non-Electron target", { target: join("C:\\", "Other", "app.exe") }],
    ["Electron with arguments", { args: "--profile safe" }],
  ])("does not migrate Electron shortcut with %s", (_label, change) => {
    const f = fixture()
    const oldPath = join(f.startMenuProgramsPath, "Electron.lnk")
    f.seed(oldPath, {
      target: join(f.root, "node_modules", "electron.exe"),
      args: "",
      appUserModelId: "ai.redcode.desktop.dev",
      ...change,
    })

    ensureNotificationShortcut(f.options())

    expect(existsSync(oldPath)).toBe(true)
    expect(readFileSync(oldPath, "utf8")).toBe("original")
  })

  test("does not migrate when replacement shortcut writing fails", () => {
    const f = fixture()
    const oldPath = join(f.startMenuProgramsPath, "Electron.lnk")
    f.seed(oldPath, {
      target: join(f.root, "node_modules", "electron.exe"),
      args: "",
      appUserModelId: "ai.redcode.desktop.dev",
    })
    f.setWriteResult(false)

    ensureNotificationShortcut(f.options())

    expect(existsSync(oldPath)).toBe(true)
    expect(f.warnings).toHaveLength(1)
    expect(existsSync(join(f.userDataPath, "shortcut-backups"))).toBe(false)
  })

  test("logs backup failures but keeps the original shortcut and completes replacement writing", () => {
    const f = fixture()
    const oldPath = join(f.startMenuProgramsPath, "Electron.lnk")
    const blockedUserData = join(f.root, "userData-file")
    writeFileSync(blockedUserData, "not a directory")
    f.seed(oldPath, {
      target: join(f.root, "node_modules", "electron.exe"),
      args: "",
      appUserModelId: "ai.redcode.desktop.dev",
    })

    ensureNotificationShortcut(f.options({ userDataPath: blockedUserData }))

    expect(existsSync(join(f.startMenuProgramsPath, "RedCode Dev.lnk"))).toBe(true)
    expect(existsSync(oldPath)).toBe(true)
    expect(f.warnings[0]?.[0]).toBe("failed to back up conflicting Electron notification shortcut")
  })

  test("uses a non-overwriting backup name and a second run leaves unrelated shortcuts alone", () => {
    const f = fixture()
    const oldPath = join(f.startMenuProgramsPath, "Electron.lnk")
    const backups = join(f.userDataPath, "shortcut-backups")
    mkdirSync(backups, { recursive: true })
    writeFileSync(join(backups, "Electron-fixed.lnk"), "existing backup")
    f.seed(oldPath, {
      target: join(f.root, "node_modules", "electron.exe"),
      args: "",
      appUserModelId: "ai.redcode.desktop.dev",
    })
    const unrelatedPath = join(f.startMenuProgramsPath, "Other App.lnk")
    f.seed(unrelatedPath, { target: "C:\\Other\\app.exe", args: "", appUserModelId: "other.app" })

    ensureNotificationShortcut(f.options({ backupId: () => "fixed" }))
    const oldBackupContents = readFileSync(join(backups, "Electron-fixed.lnk"), "utf8")
    ensureNotificationShortcut(f.options({ backupId: () => "fixed-2" }))

    expect(oldBackupContents).toBe("existing backup")
    expect(readFileSync(join(backups, "Electron-fixed.lnk"), "utf8")).toBe("existing backup")
    expect(readFileSync(join(backups, "Electron-fixed-1.lnk"), "utf8")).toBe("original")
    expect(readFileSync(unrelatedPath, "utf8")).toBe("original")
    expect(f.events.some((event) => event === `read:${unrelatedPath}`)).toBe(false)
    expect(f.details.get(unrelatedPath)).toEqual({
      target: "C:\\Other\\app.exe",
      args: "",
      appUserModelId: "other.app",
    })
  })
})
