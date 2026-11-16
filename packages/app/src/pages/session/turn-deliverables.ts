import type { AssistantMessage, Part, ToolPart } from "@redcode-ai/sdk/v2"
import { isWindowsRoot } from "@/context/file/path"
import { mediaKindFromPath } from "@redcode-ai/ui/pierre/media"

// docs/notes/implemented/feature/2026-11-16-turn-deliverables.md
export type TurnDeliverable = {
  path: string
  kind: "document" | "page" | "image" | "audio" | "file"
  change: "created" | "updated" | "moved"
  messageID: string
  partID: string
}

function kind(path: string): TurnDeliverable["kind"] {
  if (/\.(md|markdown|pdf)$/i.test(path)) return "document"
  if (/\.html?$/i.test(path)) return "page"
  const media = mediaKindFromPath(path)
  if (media === "image" || media === "svg") return "image"
  if (media === "audio") return "audio"
  return "file"
}

// Resolve only paths owned by this workspace: an external file cannot be opened by the
// existing workspace preview. Preserve literal #, %, ? and POSIX backslashes in names.
function relativePath(input: unknown, directory: string) {
  if (typeof input !== "string" || !input || !directory) return
  const windows = isWindowsRoot(directory)
  const path = windows ? input.replaceAll("\\", "/") : input
  const root = (windows ? directory.replaceAll("\\", "/") : directory).replace(/\/+$/, "")
  const compare = (value: string) => (windows ? value.toLowerCase() : value)
  const absolute = path.startsWith("/") || /^[A-Za-z]:/.test(path)
  if (absolute && !compare(path).startsWith(compare(root) + "/")) return
  const segments: string[] = []
  for (const segment of (absolute ? path.slice(root.length + 1) : path).split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (!segments.length) return
      segments.pop()
    } else segments.push(segment)
  }
  return segments.length ? segments.join("/") : undefined
}

export function collectTurnDeliverables(input: {
  userMessageID: string
  directory: string
  messages: readonly AssistantMessage[]
  parts: (messageID: string) => readonly Part[]
}): TurnDeliverable[] {
  const files = new Map<string, TurnDeliverable>()
  const key = (path: string) => (isWindowsRoot(input.directory) ? path.toLowerCase() : path)
  const remove = (path: unknown) => {
    const relative = relativePath(path, input.directory)
    if (relative) files.delete(key(relative))
  }
  const put = (path: unknown, change: TurnDeliverable["change"], part: ToolPart) => {
    const relative = relativePath(path, input.directory)
    if (!relative) return
    const previous = files.get(key(relative))
    files.set(key(relative), {
      path: relative,
      kind: kind(relative),
      change: previous?.change === "created" && change === "updated" ? "created" : change,
      messageID: part.messageID,
      partID: part.id,
    })
  }
  // Parent IDs, rather than message position, keep concurrent steering receipts and
  // other turns out of the collection. Only successful file operations are evidence.
  for (const message of input.messages) {
    if (message.parentID !== input.userMessageID) continue
    for (const part of input.parts(message.id)) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const { metadata, input: args } = part.state
      if (part.tool === "write") {
        put(metadata.filepath ?? args.filePath, metadata.exists === false ? "created" : "updated", part)
      }
      if (part.tool === "edit") {
        const diff = metadata.filediff
        put(diff && typeof diff === "object" && "file" in diff ? diff.file : args.filePath, "updated", part)
      }
      if (part.tool !== "apply_patch" || !Array.isArray(metadata.files)) continue
      for (const file of metadata.files) {
        if (!file || typeof file !== "object") continue
        if (file.type === "delete") {
          remove(file.filePath)
          continue
        }
        if (file.movePath) remove(file.filePath)
        put(file.movePath ?? file.filePath, file.movePath ? "moved" : file.type === "add" ? "created" : "updated", part)
      }
    }
  }
  // Put directly readable outputs first; retain operation order within each group.
  return [...files.values()].sort((a, b) => Number(a.kind === "file") - Number(b.kind === "file"))
}
