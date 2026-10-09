type InstanceDisposeInput = {
  key?: (directory: string) => string
  dispose: (directory: string) => Promise<unknown>
}

export function createInstanceDisposer(input: InstanceDisposeInput) {
  const requests = new Map<string, Promise<void>>()
  const key = input.key ?? ((directory: string) => directory)

  return (directory: string) => {
    const requestKey = key(directory)
    const existing = requests.get(requestKey)
    if (existing) return existing

    const request = Promise.resolve()
      .then(() => input.dispose(directory))
      .then(
        () => undefined,
        (error: unknown) => {
          // 261009 Red 直接放对象会打成 [object Object]（历史 renderer.log 全是它，无法排查）。
          // 落成可读字段；status 取到即可，不 stringify 整个 error（可能含大 response body）。
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? String((error as { status: unknown }).status)
              : undefined
          const message = error instanceof Error ? error.message : String(error)
          console.debug("[instance-dispose] request failed", { directory, message, status })
        },
      )
      .finally(() => {
        if (requests.get(requestKey) === request) requests.delete(requestKey)
      })

    requests.set(requestKey, request)
    return request
  }
}
