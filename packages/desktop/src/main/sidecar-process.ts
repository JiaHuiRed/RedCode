import { spawn, spawnSync } from "node:child_process"

const KILL_TIMEOUT = 10_000

export async function killSidecarTree(pid: number | undefined): Promise<void> {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 1 || pid === process.pid) return

  if (process.platform === "win32") {
    return killWindowsTree(pid)
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // 忽略：进程可能已经退出
  }
}

async function killWindowsTree(pid: number): Promise<void> {
  const args = ["/F", "/T", "/PID", String(pid)]
  await new Promise<void>((resolve, reject) => {
    const child = spawn("taskkill", args, { stdio: "ignore", windowsHide: true })
    const timer = setTimeout(() => {
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`taskkill timed out after ${KILL_TIMEOUT}ms`))
    }, KILL_TIMEOUT)

    let settled = false

    function onExit(code: number | null) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off("error", onError)
      if (code === 0) resolve()
      else reject(new Error(`taskkill exited with code ${code ?? "null"}`))
    }

    function onError(err: Error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off("exit", onExit)
      reject(err)
    }

    child.once("exit", onExit)
    child.once("error", onError)
  })
}

export function killSidecarTreeSync(pid: number | undefined): void {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 1 || pid === process.pid) return

  if (process.platform === "win32") {
    const args = ["/F", "/T", "/PID", String(pid)]
    try {
      // 260913 Red 同步退出路径也要有界 timeout，防止 taskkill 卡死导致主进程无法退出。
      spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: KILL_TIMEOUT })
    } catch {
      // 忽略：进程可能已经退出，或 taskkill 超时
    }
    return
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // 忽略
  }
}
