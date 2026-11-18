import { Switch } from "@redcode-ai/ui/switch"
import { useParams } from "@solidjs/router"
import { usePermission } from "@/context/permission"
import { decode64 } from "@/utils/base64"
import { Select } from "@redcode-ai/ui/select"
import { showToast } from "@redcode-ai/ui/toast"
import { type Component, createMemo, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsList, SettingsRow } from "./settings-list"

// 261031 Red 权限面板。两条约束决定了写法：
// ① permission 的优先级靠配置里键的书写顺序（core/permission.ts 的 evaluate 取 findLast），
//    所以只能逐键改写、绝不能重建整个对象——展开 ...rules() 保留原序与面板没列的未知键
//    （question / repo_clone / repo_overview / 自定义工具）；
// ② 「回到继承」在 REST 里传不了 undefined，前端传空对象，由服务端 writableGlobal 翻成删键。
const INHERIT = "inherit"
const CUSTOM = "custom"

// 与 config/permission.ts 的已知键对齐；i18n 里每项都有 title/description。
const TOOLS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "skill",
  "lsp",
  "todowrite",
  "webfetch",
  "websearch",
  "external_directory",
  "doom_loop",
] as const

export const SettingsPermissions: Component = () => {
  const language = useLanguage()
  const globalSync = useServerSync()
  const params = useParams()
  const permission = usePermission()
  const dir = createMemo(() => decode64(params.dir))
  const accepting = createMemo(() => {
    const value = dir()
    if (!value) return false
    if (!params.id) return permission.isAutoAcceptingDirectory(value)
    return permission.isAutoAccepting(params.id, value)
  })

  const toggleAccept = (checked: boolean) => {
    const value = dir()
    if (!value) return

    if (!params.id) {
      if (permission.isAutoAcceptingDirectory(value) === checked) return
      permission.toggleAutoAcceptDirectory(value)
      return
    }

    if (checked) {
      permission.enableAutoAccept(params.id, value)
      return
    }

    permission.disableAutoAccept(params.id, value)
  }

  const rules = createMemo<Record<string, unknown>>(() => {
    const value = globalSync.data.config.permission
    if (!value) return {}
    // permission: "ask" 是 {"*": "ask"} 的简写
    if (typeof value === "string") return { "*": value }
    return value as Record<string, unknown>
  })

  const options = createMemo(() => [
    { value: INHERIT, label: language.t("settings.permissions.action.inherit") },
    { value: "allow", label: language.t("settings.permissions.action.allow") },
    { value: "ask", label: language.t("settings.permissions.action.ask") },
    { value: "deny", label: language.t("settings.permissions.action.deny") },
  ])

  const level = (key: string) => {
    const value = rules()[key]
    if (value === "allow" || value === "ask" || value === "deny") return value
    // 对象形式（按目标的细规则，如 bash: { "git *": "allow" }）面板不展开，原样保留
    if (value !== undefined) return CUSTOM
    return INHERIT
  }

  const save = (key: string, next: string) => {
    if (next === CUSTOM) return
    const base: Record<string, unknown> = { ...rules() }
    // 空对象 = 服务端删除该键 = 回到继承
    base[key] = next === INHERIT ? {} : next
    void globalSync.updateConfig({ permission: base as never }).catch((err: unknown) => {
      showToast({
        title: language.t("settings.permissions.toast.updateFailed.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    })
  }

  const control = (key: string) => (
    <div class="flex items-center gap-2">
      <Show when={level(key) === CUSTOM}>
        <span class="text-11-regular text-text-weaker">{language.t("settings.permissions.action.custom")}</span>
      </Show>
      <Select
        data-action={`settings-permission-${key}`}
        options={options()}
        current={options().find((option) => option.value === level(key))}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={(option) => option && save(key, option.value)}
        variant="secondary"
        size="small"
        triggerVariant="settings"
        triggerStyle={{ "min-width": "132px" }}
      />
    </div>
  )

  return (
    <div class="settings-page-body">
      <div class="settings-page-heading">
        <div class="flex flex-col gap-1">
          <h2 class="settings-page-title">{language.t("settings.permissions.title")}</h2>
          <p class="text-12-regular text-text-weak">{language.t("settings.permissions.description")}</p>
        </div>
      </div>

      <SettingsList>
        {" "}
        <SettingsRow
          title={language.t("command.permissions.autoaccept.enable")}
          description={language.t(
            dir() ? "settings.modern.autoaccept.description" : "settings.modern.autoaccept.unavailable",
          )}
        >
          <div data-action="settings-auto-accept-permissions">
            <Switch checked={accepting()} disabled={!dir()} onChange={toggleAccept} />
          </div>
        </SettingsRow>
      </SettingsList>
      <div class="flex flex-col gap-8">
        <div class="flex flex-col gap-1" data-component="settings-permission-tools">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.permissions.section.tools")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.permissions.row.default.title")}
              description={language.t("settings.permissions.row.default.description")}
            >
              {control("*")}
            </SettingsRow>
            {TOOLS.map((tool) => (
              <SettingsRow
                title={language.t(`settings.permissions.tool.${tool}.title`)}
                description={language.t(`settings.permissions.tool.${tool}.description`)}
              >
                {control(tool)}
              </SettingsRow>
            ))}
          </SettingsList>
        </div>
      </div>
    </div>
  )
}
