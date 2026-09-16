// 260916 Red main only retains deep links until the renderer explicitly reports
// readiness. See docs/notes/implemented/bug-fix/2026-09-16-deep-link-delivery.md.
export function createDeepLinkDelivery(send: (urls: string[]) => boolean) {
  const pending: string[] = []
  let ready = false

  const flush = () => {
    if (!ready || pending.length === 0 || !send(pending)) return
    pending.splice(0)
  }

  return {
    emit: (urls: string[]) => {
      if (urls.length === 0) return
      pending.push(...urls)
      flush()
    },
    consumeInitial: () => pending.splice(0),
    markReady: () => {
      ready = true
      flush()
    },
    reset: () => {
      ready = false
    },
  }
}
