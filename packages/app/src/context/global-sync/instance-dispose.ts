type InstanceDisposeInput = {
  key?: (directory: string) => string
  dispose: (directory: string) => Promise<unknown>
  // 261011 Red 失败后的重试冷却（毫秒），测试可注入。现场：目录淘汰-重建循环下
  //   同一目录 dispose 连续重发（19:19 renderer.log 每 200ms 一轮、十几个目录
  //   并发打满 renderer→sidecar 的 HTTP/1.1 6 槽，全站请求 Failed to fetch）。
  retryCooldownMs?: number
}

const RETRY_COOLDOWN_MS = 30_000

export function createInstanceDisposer(input: InstanceDisposeInput) {
  const requests = new Map<string, Promise<void>>()
  const retryAfter = new Map<string, number>()
  const key = input.key ?? ((directory: string) => directory)
  const cooldown = input.retryCooldownMs ?? RETRY_COOLDOWN_MS
  // 261011 Red 串行闸：同 host 只有 6 个 HTTP/1.1 槽，批量淘汰一次发十几个 dispose
  //   会把槽吃光（SSE 流与会话列表一起饿死）。dispose 是 fire-and-forget 的清理，
  //   串行化只影响清理进度，不影响调用方。
  let tail: Promise<void> = Promise.resolve()

  return (directory: string) => {
    const requestKey = key(directory)
    const existing = requests.get(requestKey)
    if (existing) return existing
    const until = retryAfter.get(requestKey)
    if (until !== undefined && Date.now() < until) return Promise.resolve()

    const request = tail
      .then(() => input.dispose(directory))
      .then(
        () => {
          retryAfter.delete(requestKey)
          return undefined
        },
        (error: unknown) => {
          retryAfter.set(requestKey, Date.now() + cooldown)
          // 261009 Red 直接放对象会打成 [object Object]（历史 renderer.log 全是它，无法排查）。
          // 落成可读字段；status 取到即可，不 stringify 整个 error（可能含大 response body）。
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? String((error as { status: unknown }).status)
              : undefined
          const message = error instanceof Error ? error.message : String(error)
          // 261010 Red 上一版仍把对象字面量传给 console.debug——electron-log 的
          // spyRendererConsole 对非字符串参数直接 String()，落盘还是 [object Object]。
          // 单字符串参数才能完整落盘。
          console.debug(`[instance-dispose] request failed ${JSON.stringify({ directory, message, status })}`)
        },
      )
      .finally(() => {
        if (requests.get(requestKey) === request) requests.delete(requestKey)
      })

    tail = request
    requests.set(requestKey, request)
    return request
  }
}
