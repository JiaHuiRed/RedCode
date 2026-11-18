type ExportActions = {
  save?: (payload: string) => Promise<string | null>
  archive?: () => Promise<string>
  download: (payload: string) => void
}

export class DiagnosticsExportError extends Error {
  constructor(
    error: unknown,
    readonly savedPath?: string,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

export async function exportDiagnostics(payload: string, actions: ExportActions) {
  let saved: string | null = null
  try {
    if (actions.save) saved = await actions.save(payload)
    if (!saved) {
      actions.download(payload)
      return { kind: "download" } as const
    }
    if (!actions.archive) return { kind: "saved", path: saved } as const
    const path = await actions.archive()
    return { kind: "bundle", path } as const
  } catch (error) {
    throw new DiagnosticsExportError(error, saved ?? undefined)
  }
}
