import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

// 260913 Red runner 仅在 Windows 可加载 FFI；只替换原生适配器，执行同一份生产 IPC/清理控制流。
const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(new URL("../../src/util/windows-job-runner.ts", import.meta.url), "utf8")
    .replace(/^import .*\n/gm, "")
    .replace("export async function run()", "async function run()")
    .replace('if (process.env[RUNNER_ENV] === "1") await run()', ""),
)

for (const failure of ["assign", "resume"]) {
  test(`Windows runner releases suspended target and thread on ${failure} failure`, async () => {
    const calls: string[] = []
    const process = Object.assign(new EventEmitter(), {
      platform: "win32",
      execPath: "fixture.exe",
      env: { REDCODE_WINDOWS_JOB_RUNNER: "1" },
      connected: true,
      send(_message: unknown, callback: (failure: Error | null) => void) {
        callback(null)
        return true
      },
      disconnect() {
        this.connected = false
        process.emit("disconnect")
      },
    })
    const symbols = {
      CreateJobObjectW: () => 100,
      SetInformationJobObject: () => 1,
      uv_get_osfhandle: (fd: number) => 1000 + fd,
      SetHandleInformation: () => 1,
      CreateProcessW: (...args: unknown[]) => {
        const information = args[9] as Buffer
        information.writeBigUInt64LE(200n, 0)
        information.writeBigUInt64LE(201n, 8)
        calls.push("create suspended")
        return 1
      },
      AssignProcessToJobObject: () => {
        calls.push("assign")
        return failure === "assign" ? 0 : 1
      },
      ResumeThread: () => {
        calls.push("resume")
        return 0xffffffff
      },
      GetLastError: () => 5,
      TerminateJobObject: () => {
        calls.push("terminate job")
        return 1
      },
      TerminateProcess: () => {
        calls.push("terminate target")
        return 1
      },
      CloseHandle: (handle: number) => {
        calls.push(`close ${handle}`)
        return 1
      },
    }
    const context = {
      process,
      Buffer,
      Error,
      Promise,
      setInterval,
      clearInterval,
      dlopen: () => ({ symbols }),
      closeSync: () => {},
      windowsCommand: () => ({ executable: "fixture.exe", commandLine: "fixture.exe" }),
      result: undefined as Promise<void> | undefined,
    }
    runInNewContext(`${source}\nresult = run()`, context)
    process.emit("message", { type: "start", command: "fixture.exe", args: [], cwd: "C:\\work", env: {} })
    await context.result
    expect(calls).toContain("terminate target")
    expect(calls).toContain("close 201")
    expect(calls.indexOf("terminate target")).toBeLessThan(calls.indexOf("close 200"))
    expect(calls.filter((call) => call === "close 201")).toHaveLength(1)
  })
}
