import { Component, Show, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@redcode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { guiDiagnostics } from "@/context/gui-diagnostics"
import { SettingsList, SettingsRow } from "./settings-list"
import { DiagnosticsExportError, exportDiagnostics } from "./settings-diagnostics-export"

// 261011 Red B0（GUI 稳定性审计 §11）：开发态/故障诊断入口——开始录制、停止录制、预览、导出。
// 平时不渲染任何日志；导出前必须先能预览（§11.2），预览内容与导出内容完全相同（同一份脱敏载荷）。
export const SettingsDiagnostics: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const [store, setStore] = createStore({
    recording: guiDiagnostics.enabled(),
    count: guiDiagnostics.count(),
    preview: undefined as string | undefined,
    status: "",
    path: "",
    error: false,
    exporting: false,
  })
  const localServer = createMemo(() => server.current?.type === "sidecar" && server.current.variant === "base")
  const [logs, { refetch: refreshLogs }] = createResource(
    () => !!platform.getLogDirectories,
    () => platform.getLogDirectories!(),
  )
  const logPath = (kind: "desktop" | "server") =>
    logs.error ? undefined : kind === "desktop" ? logs()?.desktop : logs()?.server[0]

  const toggle = () => {
    if (guiDiagnostics.enabled()) guiDiagnostics.stop()
    else guiDiagnostics.start()
    setStore({
      recording: guiDiagnostics.enabled(),
      count: guiDiagnostics.count(),
      status: "",
      path: "",
      error: false,
      preview: undefined,
    })
  }

  // 面板挂载且录制中时轻量刷新计数（500ms；关闭面板即停）
  createEffect(() => {
    if (!store.recording) return
    const timer = setInterval(() => setStore("count", guiDiagnostics.count()), 500)
    onCleanup(() => clearInterval(timer))
  })

  const payloadText = () =>
    JSON.stringify(guiDiagnostics.payload({ version: platform.version, platform: platform.platform }), null, 2)

  const exportNow = async () => {
    if (store.exporting) return
    const text = store.preview ?? payloadText()
    setStore({ exporting: true, status: "", path: "", error: false })
    try {
      const result = await exportDiagnostics(text, {
        save: platform.saveGuiDiagnostics,
        archive: platform.exportDebugLogs,
        download: (payload) => {
          const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }))
          const link = document.createElement("a")
          link.href = url
          link.download = "gui-diagnostics.json"
          link.click()
          URL.revokeObjectURL(url)
        },
      })
      setStore({
        status: language.t(
          result.kind === "bundle"
            ? "settings.diagnostics.exported.bundle"
            : result.kind === "saved"
              ? "settings.desktop.diagnostics.saved"
              : "settings.diagnostics.exported.file",
        ),
        path: "path" in result ? result.path : "",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const saved = error instanceof DiagnosticsExportError ? error.savedPath : undefined
      setStore({
        error: true,
        status: `${language.t(saved ? "settings.desktop.diagnostics.partial" : "settings.diagnostics.export.failed")} ${message}`,
        path: saved ?? "",
      })
    } finally {
      setStore("exporting", false)
    }
  }

  const exportLogs = async () => {
    if (!platform.exportDebugLogs || store.exporting) return
    setStore({ exporting: true, status: "", path: "", error: false })
    try {
      const path = await platform.exportDebugLogs()
      setStore({ status: language.t("settings.desktop.logs.exported"), path })
    } catch (error) {
      setStore({ error: true, status: `${language.t("settings.diagnostics.export.failed")} ${String(error)}` })
    } finally {
      setStore("exporting", false)
    }
  }

  const openLog = async (kind: "desktop" | "server") => {
    if (!platform.openLogDirectory || (kind === "server" && !localServer())) return
    await platform.openLogDirectory(kind).catch((error: unknown) => {
      setStore({ error: true, status: `${language.t("common.requestFailed")} ${String(error)}`, path: "" })
    })
  }

  const revealExport = () => {
    if (!store.path || !platform.revealPath) return
    void platform.revealPath(store.path).catch((error: unknown) => {
      setStore({ error: true, status: `${language.t("common.requestFailed")} ${String(error)}` })
    })
  }

  return (
    <div class="settings-page-body">
      <SettingsList>
        <SettingsRow
          title={
            store.recording
              ? language.t("settings.diagnostics.state.on", { count: store.count })
              : language.t("settings.diagnostics.state.off")
          }
          description={language.t("settings.diagnostics.description")}
        >
          <div class="flex flex-wrap items-center gap-2">
            <Button variant="secondary" disabled={store.exporting} onClick={toggle}>
              {store.recording ? language.t("settings.diagnostics.stop") : language.t("settings.diagnostics.start")}
            </Button>
            <Button
              variant="ghost"
              disabled={store.count === 0 || store.exporting}
              onClick={() => setStore("preview", store.preview ? undefined : payloadText())}
            >
              {store.preview
                ? language.t("settings.diagnostics.preview.hide")
                : language.t("settings.diagnostics.preview")}
            </Button>
            <Button disabled={store.count === 0 || store.exporting} onClick={() => void exportNow()}>
              {store.exporting
                ? language.t("settings.desktop.logs.exporting")
                : language.t("settings.diagnostics.export")}
            </Button>
          </div>
        </SettingsRow>
      </SettingsList>
      <Show when={store.status}>
        <div
          role={store.error ? "alert" : "status"}
          class="flex flex-wrap items-start gap-3 rounded-lg border border-border-weak-base bg-surface-base p-4"
        >
          <div class="min-w-0 flex-1">
            <p class={store.error ? "text-12-regular text-text-on-critical-base" : "text-12-regular text-text-base"}>
              {store.status}
            </p>
            <Show when={store.path}>
              <code class="mt-1 block break-all text-11-regular text-text-weak">{store.path}</code>
            </Show>
          </div>
          <Show when={store.path && platform.revealPath}>
            <Button size="small" variant="secondary" onClick={revealExport}>
              {language.t("settings.desktop.revealFile")}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={store.preview}>
        <pre class="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-base p-4 text-11-regular text-text-weak">
          {store.preview}
        </pre>
      </Show>
      <Show when={platform.platform === "desktop"}>
        <section class="flex flex-col gap-3">
          <h3 class="text-14-medium text-text-strong">{language.t("settings.desktop.logs.title")}</h3>
          <Show when={logs.error}>
            <div role="alert" class="flex flex-wrap items-center gap-2 text-12-regular text-text-on-critical-base">
              <span>{language.t("settings.desktop.logs.loadFailed")}</span>
              <Button size="small" variant="secondary" onClick={() => void refreshLogs()}>
                {language.t("common.retry")}
              </Button>
            </div>
          </Show>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.desktop.logs.desktop")}
              description={
                <>
                  {language.t("settings.desktop.logs.desktop.description")}
                  <Show when={logPath("desktop")}>
                    <code class="mt-1 block break-all text-11-regular">{logPath("desktop")}</code>
                  </Show>
                </>
              }
            >
              <Button
                variant="secondary"
                disabled={!platform.openLogDirectory || !logPath("desktop")}
                onClick={() => void openLog("desktop")}
              >
                {language.t("settings.desktop.openFolder")}
              </Button>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.desktop.logs.server")}
              description={
                <>
                  {language.t(
                    !localServer()
                      ? "settings.desktop.logs.server.remote"
                      : logPath("server")
                        ? "settings.desktop.logs.server.description"
                        : "settings.desktop.logs.server.empty",
                  )}
                  <Show when={localServer() && logPath("server")}>
                    <code class="mt-1 block break-all text-11-regular">{logPath("server")}</code>
                  </Show>
                </>
              }
            >
              <Button
                variant="secondary"
                disabled={!platform.openLogDirectory || !localServer() || !logPath("server")}
                onClick={() => void openLog("server")}
              >
                {language.t("settings.desktop.openFolder")}
              </Button>
            </SettingsRow>
            <Show when={platform.exportDebugLogs}>
              <SettingsRow
                title={language.t("settings.desktop.logs.export")}
                description={language.t("settings.desktop.logs.export.description")}
              >
                <Button variant="secondary" disabled={store.exporting} onClick={() => void exportLogs()}>
                  {store.exporting
                    ? language.t("settings.desktop.logs.exporting")
                    : language.t("settings.desktop.logs.export")}
                </Button>
              </SettingsRow>
            </Show>
          </SettingsList>
        </section>
      </Show>
    </div>
  )
}
