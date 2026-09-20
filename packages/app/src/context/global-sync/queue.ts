type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
}

export function createRefreshQueue(input: QueueInput) {
  const queued = new Map<string, string>()
  let root = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let generation = 0

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
      void drain(scheduledGeneration)
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
          await input.bootstrap()
          if (!current(drainGeneration)) return
          await tick()
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        await Promise.all(dirs.map((dir) => input.bootstrapInstance(dir)))
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
