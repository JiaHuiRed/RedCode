import { expect, test } from "bun:test"
import { windowsCommand } from "../../src/util/windows-command"

const options = { cwd: process.cwd(), env: process.env as Record<string, string> }

test.if(process.platform === "win32")("resolves cmd shims through the command interpreter", () => {
  const invocation = windowsCommand("npm.cmd", ["--version"], options)

  expect(invocation.executable.toLowerCase()).toEndWith("cmd.exe")
  expect(invocation.commandLine).toContain("npm.cmd")
})

test("rejects null bytes before command parsing", () => {
  expect(() => windowsCommand("bun\0", [], options)).toThrow("must not contain null bytes")
})
