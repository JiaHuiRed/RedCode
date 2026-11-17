// 261009 Red 快照以请求 ID 合并拉取期间的实时变更；见 docs/notes/implemented/bug-fix/2026-10-09-client-recovery-races.md。
export function createQuestionRecovery<T extends { id: string }>(input: {
  workspace: () => string | undefined
  fetch: (workspace: string | undefined) => Promise<readonly T[]>
  read: () => readonly T[]
  apply: (requests: T[], workspace: string | undefined) => void
}) {
  let pending: { changed: Set<string> } | undefined
  let disposed = false

  return {
    changed(id: string) {
      pending?.changed.add(id)
    },
    dispose() {
      disposed = true
      pending = undefined
    },
    async recover() {
      if (disposed) return
      const workspace = input.workspace()
      const request = { changed: new Set<string>() }
      pending = request
      try {
        const snapshot = await input.fetch(workspace)
        if (disposed || pending !== request || input.workspace() !== workspace) return
        const merged = new Map(snapshot.map((item) => [item.id, item]))
        const current = new Map(input.read().map((item) => [item.id, item]))
        for (const id of request.changed) {
          const item = current.get(id)
          if (item) merged.set(id, item)
          else merged.delete(id)
        }
        input.apply([...merged.values()], workspace)
      } finally {
        if (pending === request) pending = undefined
      }
    },
  }
}
