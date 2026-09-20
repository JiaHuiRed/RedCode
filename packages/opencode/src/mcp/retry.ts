export type Mode = "default" | "none"

export interface Options<T> {
  mode?: Mode
  call: () => Promise<T>
  reconnect?: () => Promise<void>
  delay?: (milliseconds: number) => Promise<void>
  onFailure?: (input: { error: unknown; attempt: number }) => void
}

const MAX_ATTEMPTS = 3

export async function run<T>(options: Options<T>): Promise<T> {
  const attempts = options.mode === "none" ? 1 : MAX_ATTEMPTS
  const delay =
    options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await options.call()
    } catch (error) {
      lastError = error
      options.onFailure?.({ error, attempt: attempt + 1 })
      if (attempt + 1 >= attempts) break
      if (options.reconnect) {
        // 260920 Red Reconnect is best effort; preserve the original tool-call error.
        await options.reconnect().catch(() => undefined)
      }
      await delay(1000 * 2 ** attempt)
    }
  }

  throw lastError
}

export * as McpRetry from "./retry"
