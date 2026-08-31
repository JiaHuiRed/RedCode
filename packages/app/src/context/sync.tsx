import { useServerSync } from "./server-sync"
import { useSDK } from "./sdk"

// 260831 cc 本文件原先还有一份 mergeOptimisticPage / applyOptimisticAdd / applyOptimisticRemove，
//   与 directory-sync.ts 里的同名函数同构。活的是 directory-sync 那份（fetchMessages 调的是
//   它），这份零生产调用者、只有 sync-optimistic.test.ts 在导——测试绿着测一份没人跑的副本，
//   真跑的那份反而没测试兜着。已删，测试改指 directory-sync。

export const useSync = () => {
  const globalSync = useServerSync()
  const sdk = useSDK()

  return globalSync.createDirSyncContext(sdk.directory)
}
