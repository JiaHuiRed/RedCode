import { describe, expect, test } from "bun:test"
import { commandName, isWindowsExecutable } from "../../src/tool/command-name"

// 260913 Red 后缀判定必须先剥包裹引号：`"cd.exe"` 与 `cd.exe` 是同一个可执行文件，
// 漏掉它就等于给 CWD 内建豁免留了个带引号的绕过后门。
describe("command-name", () => {
  test("recognises executable suffixes even when the token is quoted", () => {
    expect(isWindowsExecutable("cd.exe")).toBe(true)
    expect(isWindowsExecutable('"cd.exe"')).toBe(true)
    expect(isWindowsExecutable("'taskkill.EXE'")).toBe(true)
    expect(isWindowsExecutable("cd")).toBe(false)
    expect(isWindowsExecutable(undefined)).toBe(false)
  })

  test.if(process.platform === "win32")("strips quotes and executable suffixes", () => {
    expect(commandName("git.exe")).toBe("git")
    expect(commandName('"cd.exe"')).toBe("cd")
    expect(commandName("C:\\Windows\\System32\\taskkill.exe")).toBe("taskkill")
  })
})
