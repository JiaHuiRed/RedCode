// 260913 Red 合并连续重连；在途请求结束后最多补一次，页面卸载后不再调度。
export function createReconnectRefresh(input: {
  refresh: () => Promise<void>
  error: (error: unknown) => void
  delay?: number
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let dirty = false
  let disposed = false
  const request = () => {
    if (disposed) return
    dirty = true
    if (running || timer !== undefined) return
    timer = setTimeout(async () => {
      timer = undefined
      if (disposed) return
      dirty = false
      running = true
      await input.refresh().catch(input.error)
      running = false
      if (dirty) request()
    }, input.delay ?? 250)
  }
  return {
    request,
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

type Page<T> = { session: T[]; part: { id: string; part: unknown[] }[]; cursor?: string; complete: boolean }

// 260913 Red 从最新页补至断线前锚点；每次最多 50 页，异常游标和超长缺口必须明确报错。
export async function fetchMessageGap<T extends { id: string }, P extends Page<T>>(
  fetch: (before?: string) => Promise<P>,
  anchor?: string,
): Promise<P> {
  const first = await fetch()
  if (!anchor) return first
  const pages = [first]
  const cursors = new Set<string>()
  while (!pages.at(-1)!.complete && !pages.at(-1)!.session.some((message) => message.id === anchor)) {
    const cursor = pages.at(-1)!.cursor
    if (!cursor || cursors.has(cursor)) throw new Error("Message recovery returned a repeated or missing cursor")
    if (pages.length >= 50)
      throw new Error("Message recovery exceeded 50 pages; the remaining history has not been synchronized")
    cursors.add(cursor)
    pages.push(await fetch(cursor))
  }
  const last = pages.at(-1)!
  return {
    ...first,
    session: pages.flatMap((page) => page.session),
    part: pages.flatMap((page) => page.part),
    cursor: last.cursor,
    complete: last.complete,
  }
}
