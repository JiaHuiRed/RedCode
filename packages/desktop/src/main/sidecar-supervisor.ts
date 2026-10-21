/**
 * sidecar 生命周期里唯一的恢复状态机（261021 第三方审计 RC21-06）。
 *
 * 旧实现有两个推动者：进程退出（server.ts 的 onExit → handleSidecarExit）和健康检查失败
 * （index.ts 的 respawnSidecar 里 healthy=false 分支）。两者各自调 respawnSidecar，而那次调用
 * 在延时与 server 检查**之前**就把恢复名额记进预算 —— 重启后已发 ready、尚未通过健康检查
 * 就退出的那一次故障，会同时走两条路，吃两个名额，并可能并发拉起两个 sidecar。
 *
 * 这里把「谁可以推动恢复」收到一处：
 * - 每次 spawn 得到一个代次；退出与健康失败都带着代次上报，**同一个代次只受理一次**；
 * - 恢复是一个单任务（`recovering`），同一时刻只会有一个；延时、启动、等待健康都在它的循环里；
 * - 预算只在「受理一次恢复」时计一次，失败原因与次数进入 failed 状态；
 * - quitting 之后任何迟到回调都不再拉起服务。
 *
 * 取舍与验收见 docs/notes/implemented/bug-fix/2026-10-21-sidecar-supervisor.md。
 */

export type SidecarPhase = "starting" | "running" | "recovering" | "failed"

export type SidecarState = {
  phase: SidecarPhase
  /** 已连续失败的恢复次数；running 时为 0。 */
  attempt: number
  /** recovering 时的等待时长。 */
  delayMs?: number
  /** failed 时的原因（给界面与诊断看）。 */
  reason?: string
  pid?: number
}

export type SupervisorSpawn = {
  pid: number | undefined
  /** 只在确认健康后 resolve；进程退出或超时都要 reject。 */
  waitHealthy: () => Promise<void>
}

export type SupervisorDeps = {
  /** 拉起一个 sidecar。onExit 必须在进程退出时被调用（包括被 kill 的情况）。 */
  spawn: (onExit: (code: number) => void) => Promise<SupervisorSpawn>
  /** 停掉当前进程。实现方不要在内部触发恢复。 */
  kill: () => Promise<void>
  delay: (ms: number) => Promise<void>
  now: () => number
  quitting: () => boolean
  log: (event: string, data: Record<string, unknown>, level: "warn" | "error") => void
  onState?: (state: SidecarState) => void
  delays?: number[]
  windowMs?: number
  maxInWindow?: number
}

const DEFAULT_DELAYS = [1000, 3000, 10_000]
const DEFAULT_WINDOW_MS = 10 * 60_000
const DEFAULT_MAX_IN_WINDOW = 5

export function createSidecarSupervisor(deps: SupervisorDeps) {
  const delays = deps.delays ?? DEFAULT_DELAYS
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS
  const maxInWindow = deps.maxInWindow ?? DEFAULT_MAX_IN_WINDOW

  let sequence = 0
  // 当前代次；0 表示没有在跑、也没有在启动。
  let current = 0
  let attempts = 0
  let times: number[] = []
  let recovering: Promise<void> | undefined
  // 有意停止（用户退出、切换、重启）：之后的退出回调不再推动恢复。
  let stopped = false
  let state: SidecarState = { phase: "starting", attempt: 0 }

  const emit = (next: SidecarState) => {
    state = next
    deps.onState?.(next)
  }

  const startOnce = async (): Promise<"healthy" | "stale"> => {
    const gen = ++sequence
    current = gen
    emit({ phase: "starting", attempt: attempts })

    let info: SupervisorSpawn
    try {
      // 260916 Red 进程死了但 MCP 子进程还活着，清孤儿由 kill 的实现在首次退出时做；
      //   这里只负责「谁推动恢复」。
      info = await deps.spawn((code) => settle(gen, `exited with code ${code}`))
    } catch (error) {
      if (gen === current) current = 0
      throw error
    }
    if (gen !== current) return "stale"
    emit({ phase: "starting", attempt: attempts, pid: info.pid })

    try {
      await info.waitHealthy()
    } catch (error) {
      if (gen !== current) return "stale"
      current = 0
      throw error
    }
    if (gen !== current) return "stale"

    attempts = 0
    emit({ phase: "running", attempt: 0, pid: info.pid })
    return "healthy"
  }

  const settle = (gen: number, reason: string) => {
    if (stopped) return false
    if (gen !== current) return false
    current = 0
    void recover(reason)
    return true
  }

  const fail = (reason: string) => {
    emit({ phase: "failed", attempt: attempts, reason })
    deps.log("sidecar recovery stopped", { reason, attempts }, "error")
  }

  const recover = (reason: string) => {
    if (stopped || deps.quitting()) return Promise.resolve()
    if (recovering) return recovering
    let why = reason
    recovering = (async () => {
      while (!stopped && !deps.quitting()) {
        const now = deps.now()
        times = times.filter((time) => now - time < windowMs)
        if (times.length >= maxInWindow) return fail(`restarted ${times.length} times within ${windowMs}ms`)
        times.push(now)
        if (attempts >= delays.length) return fail(`gave up after ${attempts} restart attempts`)

        const delayMs = delays[attempts]
        emit({ phase: "recovering", attempt: attempts + 1, delayMs, reason: why })
        deps.log("sidecar recovering", { attempt: attempts + 1, delayMs, reason: why }, "warn")
        await deps.delay(delayMs)
        if (stopped || deps.quitting()) return

        attempts += 1
        try {
          const result = await startOnce()
          if (result === "healthy") return
          why = "exited before the health check passed"
        } catch (error) {
          why = error instanceof Error ? error.message : String(error)
          deps.log("sidecar restart failed", { error: why, attempt: attempts }, "error")
          await deps.kill().catch(() => undefined)
        }
      }
    })().finally(() => {
      recovering = undefined
    })
    return recovering
  }

  return {
    /** 首次启动：失败直接上抛，交给启动流程决定怎么告诉用户。 */
    async start() {
      stopped = false
      attempts = 0
      times = []
      const result = await startOnce()
      if (result === "stale") throw new Error("Sidecar exited before the health check passed")
    },
    /**
     * 有意停止（用户退出、切换工作区、重启）。必须先于「停进程」调用：进程的退出回调
     * 看到 stopped 就不再推动恢复，否则主动停在用户眼里会变成「停在原地又被拉起来」。
     */
    stop() {
      stopped = true
      current = 0
    },
    /** 界面上的显式重试：不产生第二个恢复任务，并重置预算。 */
    retry() {
      if (recovering) return recovering
      if (deps.quitting()) return Promise.resolve()
      stopped = false
      attempts = 0
      times = []
      deps.log("sidecar recovery retry requested", {}, "warn")
      return recover("manual retry")
    },
    state: () => state,
    /** 仅供测试与诊断：当前是否有恢复任务在跑。 */
    recovering: () => recovering !== undefined,
  }
}

export type SidecarSupervisor = ReturnType<typeof createSidecarSupervisor>
