import type { FileNode } from "@redcode-ai/sdk/v2"
import { canonicalizeTreePath } from "./path"

type WatcherEvent = {
  type: string
  properties: unknown
}

type WatcherOps = {
  normalize: (input: string) => string
  hasFile: (path: string) => boolean
  isOpen?: (path: string) => boolean
  loadFile: (path: string) => void
  node: (path: string) => FileNode | undefined
  isDirLoaded: (path: string) => boolean
  refreshDir: (path: string) => void
}

export function invalidateFromWatcher(event: WatcherEvent, ops: WatcherOps) {
  if (event.type !== "file.watcher.updated") return
  const props =
    typeof event.properties === "object" && event.properties ? (event.properties as Record<string, unknown>) : undefined
  const rawPath = typeof props?.file === "string" ? props.file : undefined
  const kind = typeof props?.event === "string" ? props.event : undefined
  if (!rawPath) return
  if (!kind) return

  const path = ops.normalize(rawPath)
  if (!path) return
  // 261106 Red 审计：树键族查找走规范形（/，见 canonicalizeTreePath），与入库后的
  // 树节点键对齐；内容缓存/标签键族（hasFile/isOpen/loadFile）保持 ops 原生形态不动。
  // .git 前缀检查也必须在规范形上做，否则反斜杠事件（win32）漏拦。
  const treePath = canonicalizeTreePath(path)
  if (treePath.startsWith(".git/")) return

  if (ops.hasFile(path) || ops.isOpen?.(path)) {
    ops.loadFile(path)
  }

  if (kind === "change") {
    const dir = (() => {
      if (treePath === "") return ""
      const node = ops.node(treePath)
      if (node?.type !== "directory") return
      return treePath
    })()
    if (dir === undefined) return
    if (!ops.isDirLoaded(dir)) return
    ops.refreshDir(dir)
    return
  }
  if (kind !== "add" && kind !== "unlink") return

  const parent = treePath.split("/").slice(0, -1).join("/")
  if (!ops.isDirLoaded(parent)) return

  ops.refreshDir(parent)
}
