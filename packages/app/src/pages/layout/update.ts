import type { UpdateInstallResult } from "@/context/platform"

export function runUpdateAndRestart(
  updateAndRestart: (() => Promise<UpdateInstallResult | void>) | undefined,
  setInstalling: (installing: boolean) => void,
  onError?: (error: string) => void,
) {
  if (!updateAndRestart) return
  setInstalling(true)
  // updateAndRestart 可能正常 resolve 但进程没退出（更新器静默失败），finally 兜底清状态。
  // 261116 Red 失败结果与 IPC 异常不再吞掉：交给 onError 提示重试与日志入口。
  void updateAndRestart()
    .then((result) => {
      if (result?.status === "failed") onError?.(result.error)
    })
    .catch((err: unknown) => onError?.(err instanceof Error ? err.message : String(err)))
    .finally(() => setInstalling(false))
}
