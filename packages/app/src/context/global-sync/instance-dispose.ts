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
          console.debug("[instance-dispose] request failed", { directory, error })
        },
      )
      .finally(() => {
        if (requests.get(requestKey) === request) requests.delete(requestKey)
      })

    requests.set(requestKey, request)
    return request
  }
}
