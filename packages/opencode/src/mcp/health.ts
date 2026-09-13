import { Effect } from "effect"

export type HealthFailure<Client> = { client: Client; count: number }

const MAX_FAILURES = 3

// 260913 Red 单个服务器的失败/超时必须在 Effect 通道内收敛；重连换出的旧客户端不能修改新状态。
export function checkHealthCycle<Client>(input: {
  clients: Record<string, Client>
  connected: (name: string) => boolean
  failures: Map<string, HealthFailure<Client>>
  request: (client: Client, signal: AbortSignal) => Promise<unknown>
  unhealthy: (name: string, client: Client) => Effect.Effect<void>
  warn: (name: string, failures: number) => void
  timeout?: number
}) {
  return Effect.forEach(
    Object.entries(input.clients).filter(([name]) => input.connected(name)),
    ([name, client]) =>
      Effect.gen(function* () {
        const healthy = yield* Effect.tryPromise({
          try: (signal) => input.request(client, signal),
          catch: () => new Error("health check failed"),
        }).pipe(
          Effect.timeout(input.timeout ?? 10_000),
          Effect.match({ onSuccess: () => true, onFailure: () => false }),
        )
        if (input.clients[name] !== client || !input.connected(name)) return
        if (healthy) {
          input.failures.delete(name)
          return
        }
        const previous = input.failures.get(name)
        const count = (previous?.client === client ? previous.count : 0) + 1
        input.failures.set(name, { client, count })
        input.warn(name, count)
        if (count < MAX_FAILURES) return
        input.failures.delete(name)
        yield* input.unhealthy(name, client)
      }),
    { concurrency: "unbounded", discard: true },
  )
}
