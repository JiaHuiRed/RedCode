import { Component, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Button } from "@redcode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { guiDiagnostics } from "@/context/gui-diagnostics"
import { SettingsList, SettingsRow } from "./settings-list"

// 261011 Red B0（GUI 稳定性审计 §11）：开发态/故障诊断入口——开始录制、停止录制、预览、导出。
// 平时不渲染任何日志；导出前必须先能预览（§11.2），预览内容与导出内容完全相同（同一份脱敏载荷）。
export const SettingsDiagnostics: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const [recording, setRecording] = createSignal(guiDiagnostics.enabled())
  const [count, setCount] = createSignal(guiDiagnostics.count())
  const [preview, setPreview] = createSignal(false)
  const [status, setStatus] = createSignal("")

  const sync = () => {
    setRecording(guiDiagnostics.enabled())
    setCount(guiDiagnostics.count())
  }

  const toggle = () => {
    if (guiDiagnostics.enabled()) guiDiagnostics.stop()
    else guiDiagnostics.start()
    setStatus("")
    setPreview(false)
    sync()
  }

  // 面板挂载且录制中时轻量刷新计数（500ms；关闭面板即停）
  createEffect(() => {
    if (!recording()) return
    const timer = setInterval(() => setCount(guiDiagnostics.count()), 500)
    onCleanup(() => clearInterval(timer))
  })

  const payloadText = () =>
    JSON.stringify(guiDiagnostics.payload({ version: platform.version, platform: platform.platform }), null, 2)

  const exportNow = async () => {
    const text = payloadText()
    try {
      const save = platform.saveGuiDiagnostics
      if (save) {
        const path = await save(text)
        if (path) {
          setStatus(language.t("settings.diagnostics.exported.bundle"))
          if (platform.exportDebugLogs) await platform.exportDebugLogs().catch(() => undefined)
          return
        }
      }
      // web / 无桌面桥时的兜底：直接下载同一份脱敏载荷
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
      const link = document.createElement("a")
      link.href = url
      link.download = "gui-diagnostics.json"
      link.click()
      URL.revokeObjectURL(url)
      setStatus(language.t("settings.diagnostics.exported.file"))
    } catch {
      setStatus(language.t("settings.diagnostics.export.failed"))
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <SettingsList>
        <SettingsRow
          title={
            recording()
              ? language.t("settings.diagnostics.state.on", { count: count() })
              : language.t("settings.diagnostics.state.off")
          }
          description={language.t("settings.diagnostics.description")}
        >
          <div class="flex items-center gap-2">
            <Button variant="ghost" onClick={toggle}>
              {recording() ? language.t("settings.diagnostics.stop") : language.t("settings.diagnostics.start")}
            </Button>
            <Button
              variant="ghost"
              disabled={count() === 0}
              onClick={() => setPreview((value) => !value)}
            >
              {preview() ? language.t("settings.diagnostics.preview.hide") : language.t("settings.diagnostics.preview")}
            </Button>
            <Button disabled={count() === 0} onClick={() => void exportNow()}>
              {language.t("settings.diagnostics.export")}
            </Button>
          </div>
        </SettingsRow>
      </SettingsList>
      <Show when={status()}>
        <div class="text-12-regular text-text-weak">{status()}</div>
      </Show>
      <Show when={preview()}>
        <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-base p-3 text-11-regular text-text-weak">
          {payloadText()}
        </pre>
      </Show>
    </div>
  )
}
