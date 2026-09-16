type SidecarHealthWaitInput = {
  timeoutMs: number
  check: () => Promise<boolean>
  getFailure?: () => Error | undefined
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

// 260916 Red health wait resolves only after a confirmed probe and rejects on exit/timeout.
// See docs/notes/implemented/bug-fix/2026-09-16-sidecar-health-contract.md.
export async function waitForSidecarHealth(input: SidecarHealthWaitInput) {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? delay
  const deadline = now() + input.timeoutMs

  while (now() < deadline) {
    const failure = input.getFailure?.()
    if (failure) throw failure
    if (await input.check()) return
    const nextFailure = input.getFailure?.()
    if (nextFailure) throw nextFailure
    const remaining = deadline - now()
    if (remaining <= 0) break
    await sleep(Math.min(100, remaining))
  }

  throw new Error(`Sidecar health check timed out after ${input.timeoutMs}ms`)
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
