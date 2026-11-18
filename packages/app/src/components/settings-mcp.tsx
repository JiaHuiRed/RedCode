import { Button } from "@redcode-ai/ui/button"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { Dialog } from "@redcode-ai/ui/dialog"
import { Select } from "@redcode-ai/ui/select"
import { Switch } from "@redcode-ai/ui/switch"
import { TextField } from "@redcode-ai/ui/text-field"
import { showToast } from "@redcode-ai/ui/toast"
import type { Config, McpStatus } from "@redcode-ai/sdk/v2/client"
import { useParams } from "@solidjs/router"
import { type Component, For, Show, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { SettingsList } from "./settings-list"
import { formatMcpPairs, validateMcpForm, type McpDefinition, type McpFormValues } from "./settings-mcp-form"

// 261031 Red MCP 面板。与既有的「MCP 服务器」弹窗（dialog-select-mcp）分工：
// 那个只切运行时连接，这里管**配置**——增删改定义、开关、工具白名单。
// 删除走 DELETE /mcp/:name：定义可能写在本地覆盖层，删主文件等于没删，交给服务端逐文件处理。
type McpEntry = NonNullable<Config["mcp"]>[string]

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled",
  connecting: "mcp.status.connecting",
  deferred: "settings.desktop.mcp.deferred",
} as const

const isDefinition = (entry: McpEntry): entry is McpDefinition => "type" in entry

const McpForm: Component<{ name?: string; existing?: McpDefinition; onSaved: () => void }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const globalSync = useServerSync()
  const initial = props.existing
  const [form, setForm] = createStore<McpFormValues & { saving: boolean; error: string }>({
    name: props.name ?? "",
    type: initial?.type ?? "local",
    command: initial?.type === "local" ? JSON.stringify(initial.command) : "",
    url: initial?.type === "remote" ? initial.url : "",
    cwd: initial?.type === "local" ? (initial.cwd ?? "") : "",
    timeout: initial?.timeout === undefined ? "" : String(initial.timeout),
    tools: (initial?.tools ?? []).join(", "),
    toolsMode: initial?.tools === undefined ? "all" : initial.tools.length === 0 ? "none" : "list",
    enabled: initial?.enabled ?? true,
    environment: formatMcpPairs(initial?.type === "local" ? initial.environment : undefined, "="),
    headers: formatMcpPairs(initial?.type === "remote" ? initial.headers : undefined, ":"),
    saving: false,
    error: "",
  })

  const save = async () => {
    if (form.saving) return
    const result = validateMcpForm(form)
    if (result.error) {
      setForm("error", language.t(result.error))
      return
    }
    setForm({ saving: true, error: "" })
    try {
      await globalSync.updateConfig({ mcp: { [result.id]: result.config } })
      dialog.close()
      props.onSaved()
    } catch (error) {
      setForm(
        "error",
        `${language.t("settings.mcp.toast.saveFailed")} ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setForm("saving", false)
    }
  }

  return (
    <Dialog
      title={props.name ? language.t("settings.mcp.edit.title") : language.t("settings.mcp.add")}
      description={language.t("settings.mcp.form.description")}
    >
      <fieldset disabled={form.saving} class="flex min-w-0 flex-col gap-4">
        <TextField
          label={language.t("settings.mcp.form.name")}
          value={form.name}
          onChange={(value) => setForm("name", value)}
          disabled={!!props.name}
          spellcheck={false}
          autocomplete="off"
        />
        <div class="flex flex-col gap-1.5">
          <span class="text-12-medium text-text-strong">{language.t("settings.mcp.form.type")}</span>
          <Select
            options={[
              { value: "local", label: language.t("settings.mcp.type.local") },
              { value: "remote", label: language.t("settings.mcp.type.remote") },
            ]}
            current={{ value: form.type, label: language.t(`settings.mcp.type.${form.type}`) }}
            value={(option) => option.value}
            label={(option) => option.label}
            onSelect={(option) => option && setForm("type", option.value === "remote" ? "remote" : "local")}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerProps={{ "aria-label": language.t("settings.mcp.form.type") }}
          />
        </div>
        <Show
          when={form.type === "local"}
          fallback={
            <TextField
              label={language.t("settings.mcp.form.url")}
              value={form.url}
              onChange={(value) => setForm("url", value)}
              placeholder="https://example.com/mcp"
              spellcheck={false}
              autocomplete="off"
            />
          }
        >
          <TextField
            label={language.t("settings.mcp.form.command")}
            value={form.command}
            onChange={(value) => setForm("command", value)}
            placeholder='["npx", "-y", "some-mcp-server"]'
            spellcheck={false}
            autocomplete="off"
          />
          <TextField
            label={language.t("settings.mcp.form.cwd")}
            value={form.cwd}
            onChange={(value) => setForm("cwd", value)}
            placeholder={language.t("settings.mcp.form.optional")}
            spellcheck={false}
            autocomplete="off"
          />
        </Show>
        <TextField
          label={language.t("settings.mcp.form.timeout")}
          value={form.timeout}
          onChange={(value) => setForm("timeout", value)}
          type="number"
          min="1"
          step="1"
          placeholder="30000"
          autocomplete="off"
        />
        <div class="flex flex-col gap-1.5">
          <span class="text-12-medium text-text-strong">{language.t("settings.mcp.form.tools")}</span>
          <Select
            options={[
              { value: "all", label: language.t("settings.mcp.tools.mode.all") },
              { value: "list", label: language.t("settings.mcp.tools.mode.list") },
              { value: "none", label: language.t("settings.mcp.tools.mode.none") },
            ]}
            current={{ value: form.toolsMode, label: language.t(`settings.mcp.tools.mode.${form.toolsMode}`) }}
            value={(option) => option.value}
            label={(option) => option.label}
            onSelect={(option) =>
              option &&
              setForm("toolsMode", option.value === "list" ? "list" : option.value === "none" ? "none" : "all")
            }
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerProps={{ "aria-label": language.t("settings.mcp.form.tools") }}
          />
        </div>
        <Show when={form.toolsMode === "list"}>
          <TextField
            label={language.t("settings.mcp.form.tools.names")}
            value={form.tools}
            onChange={(value) => setForm("tools", value)}
            placeholder="search, read_file"
            spellcheck={false}
            autocomplete="off"
          />
        </Show>
        <Switch
          checked={form.enabled}
          onChange={(value) => setForm("enabled", value)}
          description={language.t("settings.desktop.mcp.startup.description")}
        >
          {language.t("settings.desktop.mcp.startup")}
        </Switch>
        <details class="rounded-lg border border-border-weak-base bg-surface-base p-4">
          <summary class="cursor-pointer text-12-medium text-text-strong">
            {language.t("settings.desktop.mcp.advanced")}
          </summary>
          <div class="mt-4 flex flex-col gap-3">
            <Show
              when={form.type === "local"}
              fallback={
                <TextField
                  multiline
                  label={language.t("settings.desktop.mcp.headers")}
                  description={language.t("settings.desktop.mcp.headers.description")}
                  value={form.headers}
                  onChange={(value) => setForm("headers", value)}
                  placeholder="Header-Name: value"
                  spellcheck={false}
                  autocomplete="off"
                  class="min-h-24 font-mono"
                />
              }
            >
              <TextField
                multiline
                label={language.t("settings.desktop.mcp.environment")}
                description={language.t("settings.desktop.mcp.environment.description")}
                value={form.environment}
                onChange={(value) => setForm("environment", value)}
                placeholder="KEY=value"
                spellcheck={false}
                autocomplete="off"
                class="min-h-24 font-mono"
              />
            </Show>
            <p class="text-12-regular text-text-weak">{language.t("settings.desktop.mcp.advanced.description")}</p>
          </div>
        </details>
        <Show when={form.error}>
          <p role="alert" class="rounded-lg bg-surface-raised-base p-3 text-12-regular text-text-on-critical-base">
            {form.error}
          </p>
        </Show>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={form.saving} onClick={() => void save()}>
            {language.t(form.saving ? "common.saving" : "common.save")}
          </Button>
        </div>
      </fieldset>
    </Dialog>
  )
}

export const SettingsMcp: Component = () => {
  const language = useLanguage()
  const globalSync = useServerSync()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const params = useParams()
  const [store, setStore] = createStore({ busy: {} as Record<string, boolean>, errors: {} as Record<string, string> })
  const dir = createMemo(() => decode64(params.dir))
  const entries = createMemo(() => Object.entries(globalSync.data.config.mcp ?? {}))
  const [statuses, { refetch }] = createResource(
    () => dir() ?? "",
    (directory) => globalSDK.client.mcp.status(directory ? { directory } : undefined).then((res) => res.data ?? {}),
    { initialValue: {} as Record<string, McpStatus> },
  )
  const statusOf = (name: string) => (statuses.error ? undefined : statuses()[name])
  const statusLabel = (name: string) => {
    const status = statusOf(name)?.status
    return language.t((status && statusLabels[status]) || "settings.desktop.mcp.unknown")
  }
  const statusError = (name: string) => {
    const status = statusOf(name)
    return status && "error" in status ? status.error : undefined
  }

  const toggle = async (name: string) => {
    const status = statusOf(name)?.status
    if (!status || status === "connecting" || statuses.loading || store.busy[name]) return
    setStore("busy", name, true)
    setStore("errors", name, "")
    try {
      if (status === "connected")
        await globalSDK.client.mcp.disconnect({ name, ...(dir() ? { directory: dir() } : {}) })
      else await globalSDK.client.mcp.connect({ name, ...(dir() ? { directory: dir() } : {}) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStore("errors", name, message)
      showToast({ title: language.t("settings.mcp.toast.toggleFailed"), description: message })
    } finally {
      setStore("busy", name, false)
      void refetch()
    }
  }

  const remove = async (name: string) => {
    if (store.busy[name]) return
    setStore("busy", name, true)
    setStore("errors", name, "")
    try {
      const result = await globalSDK.client.mcp.remove({ name, ...(dir() ? { directory: dir() } : {}) })
      globalSync.refreshGlobal()
      showToast(
        result.data
          ? {
              variant: "success",
              icon: "circle-check",
              title: language.t("settings.mcp.toast.removed.title"),
              description: language.t("settings.mcp.toast.removed.description", { name }),
            }
          : { title: language.t("settings.mcp.toast.removeMissing"), description: name },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStore("errors", name, message)
      showToast({ title: language.t("settings.mcp.toast.removeFailed"), description: message })
    } finally {
      setStore("busy", name, false)
      void refetch()
    }
  }

  const openForm = (name?: string) => {
    const entry = name ? globalSync.data.config.mcp?.[name] : undefined
    dialog.push(() => (
      <McpForm name={name} existing={entry && isDefinition(entry) ? entry : undefined} onSaved={() => void refetch()} />
    ))
  }

  return (
    <div class="settings-page-body">
      <header>
        <h2 class="settings-page-title">{language.t("settings.mcp.title")}</h2>
        <p class="settings-page-description">{language.t("settings.mcp.description")}</p>
      </header>
      <p class="rounded-lg bg-surface-raised-base p-3 text-12-regular text-text-weak">
        {language.t("settings.desktop.mcp.runtime.description")}
      </p>
      <Show when={statuses.error}>
        <div role="alert" class="flex flex-wrap items-center gap-3 rounded-lg border border-border-weak-base p-3">
          <p class="min-w-0 flex-1 text-12-regular text-text-on-critical-base">
            {language.t("settings.desktop.mcp.statusFailed")}
          </p>
          <Button size="small" variant="secondary" disabled={statuses.loading} onClick={() => void refetch()}>
            {language.t("common.retry")}
          </Button>
        </div>
      </Show>
      <SettingsList>
        <Show
          when={entries().length > 0}
          fallback={<div class="py-4 text-14-regular text-text-weak">{language.t("settings.mcp.empty")}</div>}
        >
          <For each={entries()}>
            {([name, entry]) => (
              <div class="flex flex-wrap items-center justify-between gap-4 py-4 border-b border-border-weak-base last:border-none">
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-14-medium text-text-strong truncate">{name}</span>
                    <span class="rounded-md bg-surface-raised-base px-2 py-1 text-11-regular text-text-weak">
                      {isDefinition(entry)
                        ? language.t(`settings.mcp.type.${entry.type}`)
                        : language.t("settings.mcp.type.override")}
                    </span>
                    <span aria-live="polite" class="text-12-regular text-text-weak">
                      {statuses.loading ? language.t("common.loading") : statusLabel(name)}
                    </span>
                  </div>
                  <Show when={isDefinition(entry)}>
                    <span class="break-all text-12-regular text-text-weak">
                      {isDefinition(entry) ? (entry.type === "local" ? entry.command.join(" ") : entry.url) : ""}
                    </span>
                  </Show>
                  <div class="flex flex-wrap gap-x-3 gap-y-1 text-11-regular text-text-weak">
                    <span>
                      {language.t(
                        entry.enabled === false
                          ? "settings.desktop.mcp.startup.off"
                          : "settings.desktop.mcp.startup.on",
                      )}
                    </span>
                    <Show when={isDefinition(entry)}>
                      <span>
                        {isDefinition(entry)
                          ? entry.tools === undefined
                            ? language.t("settings.mcp.tools.mode.all")
                            : entry.tools.length === 0
                              ? language.t("settings.mcp.tools.mode.none")
                              : language.t("settings.mcp.tools.count", { count: String(entry.tools.length) })
                          : ""}
                      </span>
                    </Show>
                  </div>
                  <Show when={store.errors[name] || statusError(name)}>
                    <p role="alert" class="break-words text-12-regular text-text-on-critical-base">
                      {store.errors[name] || statusError(name)}
                    </p>
                  </Show>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <Show
                    when={statusOf(name)}
                    fallback={
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={statuses.loading}
                        onClick={() => void refetch()}
                      >
                        {language.t("common.retry")}
                      </Button>
                    }
                  >
                    <div class="flex items-center gap-2 pr-1">
                      <span class="text-11-regular text-text-weak">{language.t("settings.desktop.mcp.runtime")}</span>
                      <Switch
                        checked={statusOf(name)?.status === "connected"}
                        onChange={() => void toggle(name)}
                        disabled={store.busy[name] || statuses.loading || statusOf(name)?.status === "connecting"}
                        aria-label={language.t("settings.desktop.mcp.runtime.label", { name })}
                      />
                    </div>
                  </Show>
                  <Show when={isDefinition(entry)}>
                    <Button size="small" variant="secondary" disabled={store.busy[name]} onClick={() => openForm(name)}>
                      {language.t("common.edit")}
                    </Button>
                  </Show>
                  <Button size="small" variant="ghost" disabled={store.busy[name]} onClick={() => void remove(name)}>
                    {language.t("common.delete")}
                  </Button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </SettingsList>
      <div>
        <Button variant="secondary" icon="plus-small" onClick={() => openForm()}>
          {language.t("settings.mcp.add")}
        </Button>
      </div>
    </div>
  )
}
