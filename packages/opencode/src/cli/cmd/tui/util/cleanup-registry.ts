// 260602 Red 统一清理注册表

const fns: Array<() => void | Promise<void>> = []
let running = false

export function register(fn: () => void | Promise<void>) {
  fns.push(fn)
}

export function unregister(fn: () => void | Promise<void>) {
  const i = fns.indexOf(fn)
  if (i !== -1) fns.splice(i, 1)
}

export async function runAll() {
  if (running) return
  running = true
  for (const fn of fns) {
    try {
      await fn()
    } catch {
      // ignore individual cleanup errors
    }
  }
  fns.length = 0
  running = false
}
