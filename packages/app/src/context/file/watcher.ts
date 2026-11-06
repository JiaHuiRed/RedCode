import type { FileNode } from "@redcode-ai/sdk/v2"
import { canonicalizeTreePath } from "./path"

type WatcherEvent = {
  type: string
  properties: unknown
}

type WatcherOps = {
  normalize: (input: string) => string
  // 261106 Red 自审计 P2-02：树键族归一跟工作区根形态走（见 canonicalizeTreePath）
  windows: boolean
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
  // 树节点键对齐；.git 前缀检查也必须在规范形上做，否则反斜杠事件（win32）漏拦。
  const treePath = canonicalizeTreePath(path, ops.windows)
  if (treePath.startsWith(".git/")) return

  // 261106 Red 自审计 P2-01 收尾：内容缓存/标签键族的实际形态取决于打开入口——
  // 标签与树点击经 pathFromTab 恒为规范形，搜索结果可能带原生反斜杠；原实现只拿
  // 事件原生形态逐字比对，Windows 下树/标签打开的文件两侧全 miss，外部修改不再
  // 触发强制重载。比较键统一走规范形、命中哪个键就用哪个键触发重载，不新增另一
  // 种形态的缓存记录。
  const contentPath = [treePath, path].find((p) => ops.hasFile(p) || ops.isOpen?.(p))
  if (contentPath) {
    ops.loadFile(contentPath)
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
