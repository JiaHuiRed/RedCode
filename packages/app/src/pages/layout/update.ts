export function runUpdateAndRestart(
  updateAndRestart: (() => Promise<void>) | undefined,
  setInstalling: (installing: boolean) => void,
) {
  if (!updateAndRestart) return
  setInstalling(true)
  // updateAndRestart 可能正常 resolve 但进程没退出（更新器静默失败），finally 兜底清状态
  void updateAndRestart()
    .catch(() => undefined)
    .finally(() => setInstalling(false))
}
