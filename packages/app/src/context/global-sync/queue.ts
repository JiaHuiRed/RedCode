type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
  /** 目录超出重试预算后的可观察失败上报；directory 为 undefined 表示根 bootstrap 失败 */
  onFail?: (directory: string | undefined, error: unknown) => void
}

export function createRefreshQueue(input: QueueInput) {
  const queued = new Map<string, string>()
  let root = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let generation = 0
  // 261011 Red B1-a: 失败目录的有界重试计数（键为归一化目录键）。超出上限交给
  // onFail 进入可观察失败态，等下一次明确触发（push/refresh）才重来。
  const attempts = new Map<string, number>()
  const MAX_ATTEMPTS = 3

  const key = input.key ?? ((directory: string) => directory)
  const current = (value: number) => !disposed && value === generation

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items: string[] = []
    for (const [id, directory] of queued) {
      queued.delete(id)
      items.push(directory)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (disposed || timer) return
    const scheduledGeneration = generation
    timer = setTimeout(() => {
      timer = undefined
      if (!current(scheduledGeneration)) return
      // 261011 Red: drain 内已按目录隔离失败；这里兜底任何意外 reject，杜绝
      // unhandled rejection（此前 `void drain(...)` 会把拒绝直接抛给运行时）。
      void drain(scheduledGeneration).catch((error) => {
        input.onFail?.(undefined, error)
      })
    }, 0)
  }

  const push = (directory: string) => {
    if (!directory || disposed) return
    queued.set(key(directory), directory)
    if (input.paused()) return
    schedule()
  }

  const refresh = () => {
    if (disposed) return
    root = true
    if (input.paused()) return
    schedule()
  }

  async function drain(drainGeneration: number) {
    if (running || !current(drainGeneration)) return
    running = true
    try {
      while (current(drainGeneration)) {
        if (input.paused()) return
        if (root) {
          root = false
          try {
            await input.bootstrap()
          } catch (error) {
            // 261011 Red: 根 bootstrap 失败不再中断 drain（B1-a）；调用方再次
            // refresh() 即可明确重试，失败经 onFail 上报。
            if (current(drainGeneration)) input.onFail?.(undefined, error)
          }
          if (!current(drainGeneration)) return
          await tick()
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        await Promise.all(
          dirs.map(async (dir) => {
            try {
              await input.bootstrapInstance(dir)
              attempts.delete(key(dir))
            } catch (error) {
              const k = key(dir)
              const count = (attempts.get(k) ?? 0) + 1
              if (count < MAX_ATTEMPTS && current(drainGeneration)) {
                // 261011 Red: 单目录失败不再中断整批（B/C 照常）；同一触发周期内
                // 有界自动重试，不紧循环、不无限。
                attempts.set(k, count)
                queued.set(k, dir)
              } else {
                attempts.delete(k)
                if (current(drainGeneration)) input.onFail?.(dir, error)
              }
            }
          }),
        )
        if (!current(drainGeneration)) return
        await tick()
      }
    } finally {
      running = false
      if (!current(drainGeneration)) return
      // oxlint-disable-next-line no-unsafe-finally -- intentional: early return skips schedule() when paused
      if (input.paused()) return
      if (root || queued.size) schedule()
    }
  }

  return {
    push,
    refresh,
    clear(directory: string) {
      queued.delete(key(directory))
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      queued.clear()
      root = false
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
