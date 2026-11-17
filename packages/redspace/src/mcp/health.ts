import { Effect } from "effect"

export type HealthFailure<Client> = { client: Client; count: number; error: string }

const MAX_FAILURES = 3

// 260913 Red 单个服务器的失败/超时必须在 Effect 通道内收敛；重连换出的旧客户端不能修改新状态。
export function checkHealthCycle<Client>(input: {
  clients: Record<string, Client>
  connected: (name: string) => boolean
  failures: Map<string, HealthFailure<Client>>
  request: (client: Client, signal: AbortSignal) => Promise<unknown>
  unhealthy: (name: string, client: Client, error: string) => Effect.Effect<void>
  warn: (name: string, failures: number, error: string) => void
  timeout?: number
}) {
  return Effect.forEach(
    Object.entries(input.clients).filter(([name]) => input.connected(name)),
    ([name, client]) =>
      Effect.gen(function* () {
        const timeout = input.timeout ?? 10_000
        const result = yield* Effect.tryPromise({
          try: (signal) => input.request(client, signal),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(
          Effect.timeoutOption(timeout),
          Effect.match({
            onSuccess: (response) =>
              response._tag === "Some"
                ? { healthy: true as const }
                : { healthy: false as const, error: `Timed out after ${timeout}ms` },
            onFailure: (error) => ({
              healthy: false as const,
              error: error instanceof Error ? error.message : String(error),
            }),
          }),
        )
        if (input.clients[name] !== client || !input.connected(name)) return
        if (result.healthy) {
          input.failures.delete(name)
          return
        }
        const previous = input.failures.get(name)
        const count = (previous?.client === client ? previous.count : 0) + 1
        input.failures.set(name, { client, count, error: result.error })
        input.warn(name, count, result.error)
        if (count < MAX_FAILURES) return
        input.failures.delete(name)
        yield* input.unhealthy(name, client, result.error)
      }),
    { concurrency: "unbounded", discard: true },
  )
}
