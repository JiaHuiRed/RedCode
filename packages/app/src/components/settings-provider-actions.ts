export class ProviderRefreshError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

export async function disconnectSettingsProvider(actions: {
  configured: boolean
  disable: () => Promise<unknown>
  removeCredentials: () => Promise<unknown>
  refresh: () => Promise<unknown>
}) {
  if (actions.configured) {
    await actions.disable()
    return
  }
  await actions.removeCredentials()
  await actions.refresh().catch((error: unknown) => {
    throw new ProviderRefreshError(error)
  })
}
