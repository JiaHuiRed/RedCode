import { createStore } from "solid-js/store"
import { Identifier } from "./id"

const MAX_FILES = 4
const MAX_BYTES = 10 * 1024 * 1024

export type ChatAttachment = { id: string; filename: string; mime: string; url: string }
type DraftFile = ChatAttachment & { owner: string }
type FileError = { type: "tooMany" } | { type: "tooLarge" | "readFailed"; name: string }

export function createChatAttachments(read: (file: File) => Promise<string>) {
  const [state, set] = createStore({ files: [] as DraftFile[], errors: {} as Record<string, FileError | undefined> })
  const files = (owner: string) => state.files.filter((file) => file.owner === owner)
  const remove = (ids: Set<string>) => set("files", (list) => list.filter((file) => !ids.has(file.id)))

  return {
    files,
    limit: MAX_FILES,
    error: (owner: string) => state.errors[owner],
    pending: (owner: string) => files(owner).some((file) => !file.url),
    remove,
    assignDefault(owner: string) {
      const unbound = files("default")
      if (!unbound.length && !state.errors.default) return
      const room = MAX_FILES - files(owner).length
      remove(new Set(unbound.slice(room).map((file) => file.id)))
      set("files", (file) => file.owner === "default", "owner", owner)
      set("errors", owner, unbound.length > room ? { type: "tooMany" } : (state.errors.default ?? state.errors[owner]))
      set("errors", "default", undefined)
    },
    async add(owner: string, incoming: readonly File[]) {
      set("errors", owner, undefined)
      const reads: Promise<void>[] = []
      for (const file of incoming) {
        if (files(owner).length >= MAX_FILES) {
          set("errors", owner, { type: "tooMany" })
          break
        }
        if (file.size > MAX_BYTES) {
          set("errors", owner, { type: "tooLarge", name: file.name })
          continue
        }
        // Reserve before reading. A second pick sees the slot, even while FileReader is busy.
        const id = Identifier.ascending("part")
        set("files", (list) => [
          ...list,
          { owner, id, filename: file.name, mime: file.type || "application/octet-stream", url: "" },
        ])
        reads.push(
          read(file).then(
            (url) => {
              set("files", (entry) => entry.id === id, "url", url)
            },
            () => {
              const entry = state.files.find((entry) => entry.id === id)
              if (!entry) return
              set("errors", entry.owner, { type: "readFailed", name: file.name })
              remove(new Set([id]))
            },
          ),
        )
      }
      await Promise.all(reads)
    },
  }
}
