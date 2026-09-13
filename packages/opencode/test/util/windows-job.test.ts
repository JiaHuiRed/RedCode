import { describe, expect, test } from "bun:test"
import { ChildProcess } from "node:child_process"
import { manage, terminate, WindowsJob } from "../../src/util/windows-job"

// 260913 Red 只替换 OS/IPC 边界，绑定与终止走生产路径，不启动真实用户进程。
function runner(send: ChildProcess["send"]) {
  const child = new ChildProcess()
  const signals: Array<NodeJS.Signals | number | undefined> = []
  child.kill = (signal) => {
    signals.push(signal)
    return true
  }
  child.send = send
  Object.defineProperty(child, "connected", { value: true, writable: true })
  return { child: manage(child, "fixture.exe", [], {}), signals }
}

describe("Windows Job runner termination", () => {
  test("SIGKILL bypasses an unresponsive IPC channel", () => {
    let sends = 0
    const fixture = runner(() => {
      sends++
      return true
    })
    expect(fixture.child.kill("SIGKILL")).toBe(true)
    expect(sends).toBe(0)
    expect(fixture.signals).toEqual(["SIGKILL"])
  })

  test("synchronous IPC failure falls back exactly once", () => {
    let sends = 0
    const fixture = runner(() => {
      sends++
      throw new Error("IPC closed")
    })
    fixture.child.kill()
    expect(sends).toBe(1)
    expect(fixture.signals).toEqual(["SIGKILL"])
  })

  test("asynchronous IPC failure falls back exactly once", () => {
    const fixture = runner((_message, callback) => {
      if (typeof callback === "function") callback(new Error("IPC closed"))
      return false
    })
    fixture.child.kill()
    expect(fixture.signals).toEqual(["SIGKILL"])
  })

  test("disconnected IPC still forces cleanup", () => {
    const fixture = runner(() => true)
    Object.defineProperty(fixture.child, "connected", { value: false })
    if (!WindowsJob.isManaged(fixture.child)) throw new Error("not managed")
    terminate(fixture.child)
    expect(fixture.signals).toEqual(["SIGKILL"])
  })

  test("numeric SIGKILL still kills descendants after target exit", async () => {
    const fixture = runner(() => true)
    fixture.child.emit("message", { type: "exit", code: 0 })
    expect(await fixture.child.exited).toBe(0)
    fixture.child.kill(9)
    expect(fixture.signals).toEqual(["SIGKILL"])
  })

  test("signal zero remains a liveness probe", () => {
    const fixture = runner(() => {
      throw new Error("probe must not send IPC")
    })
    fixture.child.kill(0)
    expect(fixture.signals).toEqual([0])
  })

  test("start request synchronous failure rejects the target result and kills the runner", async () => {
    const fixture = runner(() => {
      throw new Error("start IPC closed")
    })
    fixture.child.emit("message", { type: "ready" })
    await expect(fixture.child.exited).rejects.toThrow("start IPC closed")
    expect(fixture.signals).toEqual(["SIGKILL"])
  })
})
