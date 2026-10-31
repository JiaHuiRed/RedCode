import { Button } from "@redcode-ai/ui/button"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { Dialog } from "@redcode-ai/ui/dialog"
import { Select } from "@redcode-ai/ui/select"
import { Switch } from "@redcode-ai/ui/switch"
import { TextField } from "@redcode-ai/ui/text-field"
import { showToast } from "@redcode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { type Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { SettingsList } from "./settings-list"

// 261031 Red MCP 面板。与既有的「MCP 服务器」弹窗（dialog-select-mcp）分工：
// 那个只切运行时连接，这里管**配置**——增删改定义、开关、工具白名单。
// 删除走 DELETE /mcp/:name：定义可能写在本地覆盖层，删主文件等于没删，交给服务端逐文件处理。
type McpEntry = {
  type: "local" | "remote"
  command?: string[]
  url?: string
  cwd?: string
  enabled?: boolean
  timeout?: number
  tools?: string[]
}

const parseCommand = (value: string): string[] => {
  const text = value.trim()
  if (!text) return []
  // 带空格的可执行路径只能靠 JSON 数组表达，否则按空白切。解析失败返回空数组，
  // 由调用方按「输入非空但解析不出」判为无效，别静默保存成一条断掉的命令。
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return text.split(/\s+/).filter(Boolean)
}

const parseList = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled",
} as const

// config.mcp 允许 legacy 形态 `{ enabled: false }` —— 它只是对本机覆盖层的开关，
// 没有 type/command。这种条目不能按完整定义编辑（会把空 url 写进主配置），只给删除。
const isOverride = (entry: McpEntry) => entry.type !== "local" && entry.type !== "remote"

const McpForm: Component<{ name?: string; existing?: McpEntry; onSaved: () => void }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const globalSync = useServerSync()

  const [name, setName] = createSignal(props.name ?? "")
  const [type, setType] = createSignal<"local" | "remote">(props.existing?.type ?? "local")
  // 261031 Red 编辑态按 JSON 数组回显：command.join(" ") 会把带空格的参数
  // （如 C:\My Tools\server.py）拆成两个 token，保存一次就得到一条坏掉的启动命令。
  const [command, setCommand] = createSignal(
    props.existing?.command?.length ? JSON.stringify(props.existing.command) : "",
  )
  const [url, setUrl] = createSignal(props.existing?.url ?? "")
  const [cwd, setCwd] = createSignal(props.existing?.cwd ?? "")
  const [timeout, setTimeoutValue] = createSignal(props.existing?.timeout ? String(props.existing.timeout) : "")
  const [tools, setTools] = createSignal((props.existing?.tools ?? []).join(", "))
  // 261031 Red 白名单三态：不写 tools = 开放全部，[] = 屏蔽全部，非空数组 = 指定清单。
  // 空输入框不能同时代表「全部」和「无」，否则清空白名单会静默保留旧规则。
  const [toolsMode, setToolsMode] = createSignal<"all" | "list" | "none">(
    props.existing?.tools === undefined ? "all" : props.existing.tools.length === 0 ? "none" : "list",
  )
  const [enabled, setEnabled] = createSignal(props.existing?.enabled ?? true)
  const [saving, setSaving] = createSignal(false)

  const save = async () => {
    const id = name().trim()
    if (!id || saving()) return
    const commandList = parseCommand(command())
    if (type() === "local" && command().trim() && commandList.length === 0) {
      showToast({ title: language.t("settings.mcp.toast.commandInvalid") })
      return
    }
    if (toolsMode() === "list" && parseList(tools()).length === 0) {
      showToast({ title: language.t("settings.mcp.toast.toolsRequired") })
      return
    }
    const shared = {
      enabled: enabled(),
      ...(timeout().trim() ? { timeout: Number(timeout()) } : {}),
      // 「全部开放」不写 tools：服务端对该键做整条替换，旧白名单会被清掉
      ...(toolsMode() === "list"
        ? { tools: parseList(tools()) }
        : toolsMode() === "none"
          ? { tools: [] as string[] }
          : {}),
    }
    const config: McpEntry =
      type() === "local"
        ? { type: "local", command: commandList, ...(cwd().trim() ? { cwd: cwd().trim() } : {}), ...shared }
        : { type: "remote", url: url().trim(), ...shared }
    setSaving(true)
    try {
      await globalSync.updateConfig({ mcp: { [id]: config } as never })
      dialog.close()
      props.onSaved()
    } catch (err) {
      showToast({
        title: language.t("settings.mcp.toast.saveFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={props.name ? language.t("settings.mcp.edit.title") : language.t("settings.mcp.add")}
      description={language.t("settings.mcp.form.description")}
    >
      <div class="flex flex-col gap-4">
        <TextField
          label={language.t("settings.mcp.form.name")}
          value={name()}
          onChange={setName}
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
            current={{ value: type(), label: language.t(`settings.mcp.type.${type()}`) }}
            value={(option) => option.value}
            label={(option) => option.label}
            onSelect={(option) => {
              if (option) setType(option.value as "local" | "remote")
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </div>
        <Show
          when={type() === "local"}
          fallback={
            <TextField
              label={language.t("settings.mcp.form.url")}
              value={url()}
              onChange={setUrl}
              placeholder="https://example.com/mcp"
              spellcheck={false}
              autocomplete="off"
            />
          }
        >
          <TextField
            label={language.t("settings.mcp.form.command")}
            value={command()}
            onChange={setCommand}
            placeholder="npx -y some-mcp-server"
            spellcheck={false}
            autocomplete="off"
          />
          <TextField
            label={language.t("settings.mcp.form.cwd")}
            value={cwd()}
            onChange={setCwd}
            placeholder={language.t("settings.mcp.form.optional")}
            spellcheck={false}
            autocomplete="off"
          />
        </Show>
        <TextField
          label={language.t("settings.mcp.form.timeout")}
          value={timeout()}
          onChange={setTimeoutValue}
          placeholder="30000"
          spellcheck={false}
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
            current={{ value: toolsMode(), label: language.t(`settings.mcp.tools.mode.${toolsMode()}`) }}
            value={(option) => option.value}
            label={(option) => option.label}
            onSelect={(option) => {
              if (option) setToolsMode(option.value as "all" | "list" | "none")
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </div>
        <Show when={toolsMode() === "list"}>
          <TextField
            label={language.t("settings.mcp.form.tools.names")}
            value={tools()}
            onChange={setTools}
            placeholder={language.t("settings.mcp.form.tools.placeholder")}
            spellcheck={false}
            autocomplete="off"
          />
        </Show>
        <div class="flex items-center justify-between">
          <span class="text-12-medium text-text-strong">{language.t("settings.mcp.form.enabled")}</span>
          <Switch checked={enabled()} onChange={setEnabled} />
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={saving()} onClick={() => void save()}>
            {language.t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export const SettingsMcp: Component = () => {
  const language = useLanguage()
  const globalSync = useServerSync()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const params = useParams()

  const dir = createMemo(() => decode64(params.dir))
  const entries = createMemo(() => Object.entries((globalSync.data.config.mcp ?? {}) as Record<string, McpEntry>))
  const [statuses, { refetch }] = createResource(
    () => dir() ?? "",
    (directory) =>
      globalSDK.client.mcp
        .status(directory ? { directory } : undefined)
        .then((res) => res.data ?? {})
        .catch(() => ({}) as Record<string, { status: string }>),
    { initialValue: {} as Record<string, { status: string }> },
  )

  const statusOf = (name: string) => statuses()[name]?.status
  const statusLabel = (name: string) => {
    const status = statusOf(name)
    const key = status ? statusLabels[status as keyof typeof statusLabels] : undefined
    return key ? language.t(key) : undefined
  }

  const toggle = async (name: string) => {
    const connected = statusOf(name) === "connected"
    try {
      if (connected) await globalSDK.client.mcp.disconnect({ name, ...(dir() ? { directory: dir() } : {}) })
      else await globalSDK.client.mcp.connect({ name, ...(dir() ? { directory: dir() } : {}) })
    } catch (err) {
      showToast({
        title: language.t("settings.mcp.toast.toggleFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
    void refetch()
  }

  const remove = async (name: string) => {
    try {
      const result = await globalSDK.client.mcp.remove({ name, ...(dir() ? { directory: dir() } : {}) })
      void refetch()
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
    } catch (err) {
      showToast({
        title: language.t("settings.mcp.toast.removeFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const openForm = (name?: string) => {
    const existing = name ? (globalSync.data.config.mcp?.[name] as McpEntry | undefined) : undefined
    dialog.show(() => <McpForm name={name} existing={existing} onSaved={() => void refetch()} />)
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.mcp.title")}</h2>
          <p class="text-12-regular text-text-weak">{language.t("settings.mcp.description")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-4 max-w-[720px]">
        <SettingsList>
          <Show
            when={entries().length > 0}
            fallback={<div class="py-4 text-14-regular text-text-weak">{language.t("settings.mcp.empty")}</div>}
          >
            <For each={entries()}>
              {([name, entry]) => (
                <div class="flex flex-wrap items-center justify-between gap-3 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <div class="flex items-center gap-2">
                      <span class="text-14-medium text-text-strong truncate">{name}</span>
                      <span class="text-11-regular text-text-weaker">
                        {isOverride(entry)
                          ? language.t("settings.mcp.type.override")
                          : language.t(`settings.mcp.type.${entry.type}`)}
                      </span>
                      <Show when={statusLabel(name)}>
                        <span class="text-11-regular text-text-weaker">{statusLabel(name)}</span>
                      </Show>
                    </div>
                    <span class="text-12-regular text-text-weak truncate">
                      {entry.type === "local" ? (entry.command ?? []).join(" ") : (entry.url ?? "")}
                    </span>
                    <Show when={entry.tools?.length}>
                      <span class="text-11-regular text-text-weaker">
                        {language.t("settings.mcp.tools.count", { count: String(entry.tools?.length ?? 0) })}
                      </span>
                    </Show>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <Switch checked={statusOf(name) === "connected"} onChange={() => void toggle(name)} />
                    <Show when={!isOverride(entry)}>
                      <Button size="small" variant="secondary" onClick={() => openForm(name)}>
                        {language.t("common.edit")}
                      </Button>
                    </Show>
                    <Button size="small" variant="ghost" onClick={() => void remove(name)}>
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
    </div>
  )
}
