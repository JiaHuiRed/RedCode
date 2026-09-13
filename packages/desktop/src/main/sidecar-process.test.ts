import { describe, expect, test } from "bun:test"
import { killSidecarTree, killSidecarTreeSync } from "./sidecar-process"

describe("sidecar-process", () => {
  test("PID guard rejects invalid pids", async () => {
    await expect(killSidecarTree(undefined)).resolves.toBeUndefined()
    await expect(killSidecarTree(NaN)).resolves.toBeUndefined()
    await expect(killSidecarTree(0)).resolves.toBeUndefined()
    await expect(killSidecarTree(1)).resolves.toBeUndefined()
    await expect(killSidecarTree(process.pid)).resolves.toBeUndefined()
  })

  if (process.platform === "win32") {
    test("killSidecarTree waits for taskkill to complete (race proof)", async () => {
      // 证明旧逻辑 fire-and-forget：创建一个长驻子进程。
      // 旧逻辑 spawn("taskkill", ...).unref() 不等待 taskkill 完成，
      // 调用方几乎立即返回；新逻辑 await taskkill 的 exit 事件，
      // 因此 elapsed 必须大于 taskkill 的实际执行时间。
      const child = Bun.spawn(["node", "-e", "setTimeout(() => {}, 60000)"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      const pid = child.pid
      if (!pid) throw new Error("no pid")

      // 等子进程稳定
      await new Promise((r) => setTimeout(r, 500))

      const t0 = Date.now()
      await killSidecarTree(pid)
      const elapsed = Date.now() - t0

      // taskkill 杀掉一个空转进程至少需要几十毫秒；
      // fire-and-forget 的旧逻辑 elapsed 会接近 0。
      expect(elapsed).toBeGreaterThan(30)
    })
  }

  test("killSidecarTreeSync does not hang forever", () => {
    // spawnSync 的 timeout 选项确保同步路径也有界；
    // 不存在的 PID 会快速失败（被 catch 吞掉），不会挂起。
    expect(() => killSidecarTreeSync(12345)).not.toThrow()
  })
})
