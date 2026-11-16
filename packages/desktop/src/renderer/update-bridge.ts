import type { UpdateCheckResult, UpdateInstallResult } from "../main/updater"
import type { WindowConfig } from "../preload/types"

// 261116 Red 渲染层保留一道禁用闸：未打包/开发构建（updaterEnabled=false）时
//   必须报「禁用」，不能回 updateAvailable:false 让设置页说「已是最新版」。
export function checkUpdateForWindow(
  config: Pick<WindowConfig, "updaterEnabled">,
  check: () => Promise<UpdateCheckResult>,
): Promise<UpdateCheckResult> {
  if (!config.updaterEnabled) return Promise.resolve({ updateAvailable: false, status: "disabled" })
  return check()
}

export function installUpdateForWindow(
  config: Pick<WindowConfig, "updaterEnabled">,
  install: () => Promise<UpdateInstallResult>,
): Promise<UpdateInstallResult> {
  if (!config.updaterEnabled) return Promise.resolve({ status: "skipped", reason: "disabled" })
  return install()
}
