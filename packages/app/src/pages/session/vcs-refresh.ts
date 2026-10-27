import { onCleanup } from "solid-js"
import type { QueryClient } from "@tanstack/solid-query"

export function createVcsRefresh(input: {
  client: QueryClient
  key: () => readonly unknown[]
  delay: number
}) {
  const pending = new Map<string, readonly unknown[]>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const flush = () => {
    for (const [id, key] of pending) {
      if (input.client.isFetching({ queryKey: key })) continue
      pending.delete(id)
      void input.client.invalidateQueries({ queryKey: key }, { cancelRefetch: false })
    }
  }
  const unsubscribe = input.client.getQueryCache().subscribe(flush)
  onCleanup(() => {
    unsubscribe()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    pending.clear()
  })
  return () => {
    const key = input.key()
    const id = JSON.stringify(key)
    const previous = timers.get(id)
    if (previous) clearTimeout(previous)
    pending.delete(id)
    timers.set(id, setTimeout(() => {
      timers.delete(id)
      pending.set(id, key)
      flush()
    }, input.delay))
  }
}
