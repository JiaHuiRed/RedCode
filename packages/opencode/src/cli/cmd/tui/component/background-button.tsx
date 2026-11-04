import { createSignal, onCleanup, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { DialogBackground } from "./dialog-background"

// 261104 Red 输入框底部的后台活动入口：常驻在模型行右侧，显示运行中的数量，点一下打开面板。
// 10 秒一轮轻量轮询（面板自己打开时是 2 秒）；服务端没有该路由时静默退回无计数。
export function BackgroundButton() {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [running, setRunning] = createSignal(0)

  onMount(() => {
    const tick = () => {
      void sdk.client.background
        .list()
        .then((result) => setRunning((result.data ?? []).filter((job) => job.status === "running").length))
        .catch(() => {
          // 旧服务端没有 /background 路由：按钮仍然可点，只是不显示计数。
        })
    }
    tick()
    const timer = setInterval(tick, 10_000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box flexShrink={0} onMouseUp={() => dialog.replace(() => <DialogBackground />)}>
      <text fg={running() > 0 ? theme.warning : theme.textMuted}>
        {running() > 0 ? `● 后台 ${running()}` : "后台"}
      </text>
    </box>
  )
}
