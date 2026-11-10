import { removeFileContentBytes } from "./content-cache"
import type { TreeSnapshot } from "./tree-store"
import type { FileState } from "./types"

// 261110 Red 外部审计第 2 项：跨工作区返回不再把刚看过的文件当第一次打开。
// FileProvider 挂在 keyed Show 下（directory-layout.tsx），scope 变化时整个子树
// 销毁重建——所以现场必须存放在 provider 生命周期之外。这里保存最近几个工作区的
// 「打开文件内容 + 文件树展开/children 状态」；滚动与选区已由 view-cache 按工作区
// 持久化，不经此处。

const MAX_WORKSPACES = 4

export type WorkspaceSnapshot = {
  files: Record<string, FileState>
  tree: TreeSnapshot
}

const snapshots = new Map<string, WorkspaceSnapshot>()

const disposeSnapshot = (snapshot: WorkspaceSnapshot) => {
  // 快照里的 content 从全局 LRU 记账中摘除：记账只描述「前台可用」的内容，
  // 总预算（content-cache 的 40 条 / 20MB）不该被后台工作区挤占。
  for (const path of Object.keys(snapshot.files)) removeFileContentBytes(path)
}

const touch = (key: string) => {
  const value = snapshots.get(key)
  if (!value) return
  snapshots.delete(key)
  snapshots.set(key, value)
}

const prune = () => {
  while (snapshots.size > MAX_WORKSPACES) {
    const oldest = snapshots.keys().next().value
    if (!oldest) return
    const value = snapshots.get(oldest)
    snapshots.delete(oldest)
    if (value) disposeSnapshot(value)
  }
}

/** 放回某工作区的现场（覆盖同 key 旧快照）。 */
export function putWorkspaceSnapshot(directory: string, snapshot: WorkspaceSnapshot) {
  const previous = snapshots.get(directory)
  if (previous) disposeSnapshot(previous)
  snapshots.delete(directory)
  snapshots.set(directory, snapshot)
  prune()
}

/** 取出并移除快照（恢复方接管后旧快照不再有意义）。 */
export function takeWorkspaceSnapshot(directory: string): WorkspaceSnapshot | undefined {
  const value = snapshots.get(directory)
  if (!value) return undefined
  snapshots.delete(directory)
  disposeSnapshot(value)
  return value
}

export function clearWorkspaceSnapshots() {
  for (const value of snapshots.values()) disposeSnapshot(value)
  snapshots.clear()
}
