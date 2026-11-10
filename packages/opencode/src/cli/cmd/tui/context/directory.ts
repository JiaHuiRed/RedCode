import { createMemo } from "solid-js"
import { useProject } from "./project"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { Global } from "@redcode-ai/core/global"

export function useDirectory() {
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  return createMemo(() => {
    // 261110 Red 目录只认所属项目；进程 cwd 是启动目录，多项目切换后不再代表当前项目
    const directory = project.instance.path().directory || sdk.directory || ""
    const result = directory.replace(Global.Path.home, "~")
    if (sync.data.vcs?.branch) return result + ":" + sync.data.vcs.branch
    return result
  })
}
