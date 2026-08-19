import { Component, Show, createMemo, createResource, createSignal, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@redcode-ai/ui/button"
import { Avatar } from "@redcode-ai/ui/avatar"
import { Icon } from "@redcode-ai/ui/icon"
import { Select } from "@redcode-ai/ui/select"
import { Switch } from "@redcode-ai/ui/switch"
import { TextField } from "@redcode-ai/ui/text-field"
import { Tooltip } from "@redcode-ai/ui/tooltip"
import { useTheme, type ColorScheme } from "@redcode-ai/ui/theme/context"
import { showToast } from "@redcode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { usePlatform, type DisplayBackend } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { Link } from "./link"
import { SettingsList } from "./settings-list"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

type ThemeOption = {
  id: string
  name: string
}

type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

type ShellSelectOption = {
  id: string
  value: string
  label: string
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

export const SettingsGeneral: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const permission = usePermission()
  const platform = usePlatform()
  const params = useParams()
  const settings = useSettings()

  const [store, setStore] = createStore({
    checking: false,
  })

  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
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
  const desktop = createMemo(() => platform.platform === "desktop")

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)

    void platform
      .checkUpdate()
      .then((result) => {
        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        const actions = platform.updateAndRestart
          ? [
              {
                label: language.t("toast.update.action.installRestart"),
                onClick: async () => {
                  await platform.updateAndRestart!()
                },
              },
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]
          : [
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]

        showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
          actions,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setStore("checking", false))
  }

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  const globalSync = useServerSync()
  const globalSdk = useGlobalSDK()

  const [shells] = createResource(
    () =>
      globalSdk.client.pty
        .shells()
        .then((res) => res.data ?? [])
        .catch(() => [] as ShellOption[]),
    { initialValue: [] as ShellOption[] },
  )

  const [displayBackend, { refetch: refetchDisplayBackend }] = createResource(
    () => (linux() && platform.getDisplayBackend ? true : false),
    () => Promise.resolve(platform.getDisplayBackend?.() ?? null).catch(() => null as DisplayBackend | null),
    { initialValue: null as DisplayBackend | null },
  )

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => (desktop() && platform.getPinchZoomEnabled ? true : false),
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )

  onMount(() => {
    void theme.loadThemes()
  })

  const autoOption = { id: "auto", value: "", label: language.t("settings.general.row.shell.autoDefault") }
  const currentShell = createMemo(() => globalSync.data.config.shell ?? "")

  const shellOptions = createMemo<ShellSelectOption[]>(() => {
    const list = shells.latest
    const current = globalSync.data.config.shell

    const nameCounts = new Map<string, number>()
    for (const s of list) {
      nameCounts.set(s.name, (nameCounts.get(s.name) || 0) + 1)
    }

    const options = [
      autoOption,
      ...list.map((s) => {
        const ambiguousName = (nameCounts.get(s.name) || 0) > 1
        const text = ambiguousName ? s.path : s.name
        const label = s.acceptable ? text : `${text} (${language.t("settings.general.row.shell.terminalOnly")})`
        return {
          id: s.path,
          // Prefer name over path - "bash" is much cleaner than the explicit full route even when it may change due to PATH.
          value: ambiguousName ? s.path : s.name,
          label,
        }
      }),
    ]

    if (current && !options.some((o) => o.value === current)) {
      options.push({ id: current, value: current, label: current })
    }

    return options
  })

  const onDisplayBackendChange = (checked: boolean) => {
    const update = platform.setDisplayBackend?.(checked ? "wayland" : "auto")
    if (!update) return
    void update.finally(() => {
      void refetchDisplayBackend()
    })
  }

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch(() => setPinchZoom(!checked))
  }

  // 260814 Red busy_enter 下拉(与 TUI/GUI 的 /busy-enter 斜杠同源,写 PATCH /global/config 立即生效)
  const busyEnterOptions = createMemo((): { value: "steer" | "queue"; label: string }[] => [
    { value: "steer", label: language.t("settings.general.row.busyEnter.steer") },
    { value: "queue", label: language.t("settings.general.row.busyEnter.queue") },
  ])
  const currentBusyEnter = createMemo(() => globalSync.data.config.busy_enter ?? "steer")

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
    { value: "cream", label: language.t("theme.scheme.cream") },
    { value: "green", label: language.t("theme.scheme.green") },
    { value: "deepblue", label: language.t("theme.scheme.deepblue") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
    variant: "secondary" as const,
    size: "small" as const,
    triggerVariant: "settings" as const,
  })

  const GeneralSection = () => (
    <div class="flex flex-col gap-1">
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <Select
            data-action="settings-language"
            options={languageOptions()}
            current={languageOptions().find((o) => o.value === language.locale())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && language.setLocale(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("command.permissions.autoaccept.enable")}
          description={language.t("toast.permissions.autoaccept.on.description")}
        >
          <div data-action="settings-auto-accept-permissions">
            <Switch checked={accepting()} disabled={!dir()} onChange={toggleAccept} />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.shell.title")}
          description={language.t("settings.general.row.shell.description")}
        >
          <Select
            data-action="settings-shell"
            options={shellOptions()}
            current={shellOptions().find((o) => o.value === currentShell()) ?? autoOption}
            value={(o) => o.id}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              if (option.value === currentShell()) return
              globalSync.updateConfig({ shell: option.value })
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.busyEnter.title")}
          description={language.t("settings.general.row.busyEnter.description")}
        >
          <Select
            data-action="settings-busy-enter"
            options={busyEnterOptions()}
            current={busyEnterOptions().find((o) => o.value === currentBusyEnter())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              if (option.value === currentBusyEnter()) return
              globalSync.updateConfig({ busy_enter: option.value })
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.reasoningSummaries.title")}
          description={language.t("settings.general.row.reasoningSummaries.description")}
        >
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.shellToolPartsExpanded.title")}
          description={language.t("settings.general.row.shellToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-shell-tool-parts-expanded">
            <Switch
              checked={settings.general.shellToolPartsExpanded()}
              onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.editToolPartsExpanded.title")}
          description={language.t("settings.general.row.editToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-edit-tool-parts-expanded">
            <Switch
              checked={settings.general.editToolPartsExpanded()}
              onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showSessionProgressBar.title")}
          description={language.t("settings.general.row.showSessionProgressBar.description")}
        >
          <div data-action="settings-show-session-progress-bar">
            <Switch
              checked={settings.general.showSessionProgressBar()}
              onChange={(checked) => settings.general.setShowSessionProgressBar(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const AdvancedSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.advanced")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.showNavigation.title")}
          description={language.t("settings.general.row.showNavigation.description")}
        >
          <div data-action="settings-show-navigation">
            <Switch
              checked={settings.general.showNavigation()}
              onChange={(checked) => settings.general.setShowNavigation(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showSearch.title")}
          description={language.t("settings.general.row.showSearch.description")}
        >
          <div data-action="settings-show-search">
            <Switch
              checked={settings.general.showSearch()}
              onChange={(checked) => settings.general.setShowSearch(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showTerminal.title")}
          description={language.t("settings.general.row.showTerminal.description")}
        >
          <div data-action="settings-show-terminal">
            <Switch
              checked={settings.general.showTerminal()}
              onChange={(checked) => settings.general.setShowTerminal(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showStatus.title")}
          description={language.t("settings.general.row.showStatus.description")}
        >
          <div data-action="settings-show-status">
            <Switch
              checked={settings.general.showStatus()}
              onChange={(checked) => settings.general.setShowStatus(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const AppearanceSection = () => {
    // 260608 Red 0.4.5 聊天背景图：复用 avatar 的 FileReader→dataURL→settings 模式
    let chatBgInput: HTMLInputElement | undefined
    const handleChatBgSelect = (e: Event) => {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => settings.appearance.setChatBackground(reader.result as string)
      reader.readAsDataURL(file)
    }
    const handleChatBgRemove = () => {
      settings.appearance.setChatBackground("")
      if (chatBgInput) chatBgInput.value = ""
    }

    // 260610 Red 0.5.0 主界面背景图：与聊天背景同模式，独立设置（公司/家里分别换壁纸）
    let homeBgInput: HTMLInputElement | undefined
    const handleHomeBgSelect = (e: Event) => {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => settings.appearance.setHomeBackground(reader.result as string)
      reader.readAsDataURL(file)
    }
    const handleHomeBgRemove = () => {
      settings.appearance.setHomeBackground("")
      if (homeBgInput) homeBgInput.value = ""
    }

    return (
      <div class="flex flex-col gap-1">
        <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.appearance")}</h3>

        <SettingsList>
          <SettingsRow
            title={language.t("settings.general.row.colorScheme.title")}
            description={language.t("settings.general.row.colorScheme.description")}
          >
            <Select
              data-action="settings-color-scheme"
              options={colorSchemeOptions()}
              current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => option && theme.setColorScheme(option.value)}
              onHighlight={(option) => {
                if (!option) return
                theme.previewColorScheme(option.value)
                return () => theme.cancelPreview()
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
              triggerStyle={{ "min-width": "220px" }}
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.theme.title")}
            description={
              <>
                {language.t("settings.general.row.theme.description")}{" "}
                <Link href="https://redcode.dev/docs/themes/">{language.t("common.learnMore")}</Link>
              </>
            }
          >
            <Select
              data-action="settings-theme"
              options={themeOptions()}
              current={themeOptions().find((o) => o.id === theme.themeId())}
              value={(o) => o.id}
              label={(o) => o.name}
              onSelect={(option) => {
                if (!option) return
                theme.setTheme(option.id)
              }}
              onHighlight={(option) => {
                if (!option) return
                theme.previewTheme(option.id)
                return () => theme.cancelPreview()
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.uiFont.title")}
            description={language.t("settings.general.row.uiFont.description")}
          >
            <div class="w-full sm:w-[220px]">
              <TextField
                data-action="settings-ui-font"
                label={language.t("settings.general.row.uiFont.title")}
                hideLabel
                type="text"
                value={sans()}
                onChange={(value) => settings.appearance.setUIFont(value)}
                placeholder={sansDefault}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                class="text-12-regular"
                style={{ "font-family": sansFontFamily(settings.appearance.uiFont()) }}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.font.title")}
            description={language.t("settings.general.row.font.description")}
          >
            <div class="w-full sm:w-[220px]">
              <TextField
                data-action="settings-code-font"
                label={language.t("settings.general.row.font.title")}
                hideLabel
                type="text"
                value={mono()}
                onChange={(value) => settings.appearance.setFont(value)}
                placeholder={monoDefault}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                class="text-12-regular"
                style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.terminalFont.title")}
            description={language.t("settings.general.row.terminalFont.description")}
          >
            <div class="w-full sm:w-[220px]">
              <TextField
                data-action="settings-terminal-font"
                label={language.t("settings.general.row.terminalFont.title")}
                hideLabel
                type="text"
                value={terminal()}
                onChange={(value) => settings.appearance.setTerminalFont(value)}
                placeholder={terminalDefault}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                class="text-12-regular"
                style={{ "font-family": terminalFontFamily(settings.appearance.terminalFont()) }}
              />
            </div>
          </SettingsRow>

          <SettingsRow title="Chat Background" description="Image shown behind the chat window (applies to all chats)">
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-md border border-border-weaker-base bg-cover bg-center bg-background-stronger shrink-0"
                style={
                  settings.appearance.chatBackground()
                    ? { "background-image": `url(${settings.appearance.chatBackground()})` }
                    : {}
                }
              />
              <input
                ref={chatBgInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleChatBgSelect}
                class="hidden"
              />
              <div class="flex gap-2">
                <Button
                  data-action="settings-chat-bg-upload"
                  variant="secondary"
                  size="small"
                  onClick={() => chatBgInput?.click()}
                >
                  Upload
                </Button>
                <Show when={settings.appearance.chatBackground()}>
                  <Button
                    data-action="settings-chat-bg-remove"
                    variant="ghost"
                    size="small"
                    onClick={handleChatBgRemove}
                  >
                    Remove
                  </Button>
                </Show>
              </div>
            </div>
          </SettingsRow>

          <SettingsRow
            title="Home Background"
            description="Image shown behind the home / no-session screen (independent from chat background)"
          >
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-md border border-border-weaker-base bg-cover bg-center bg-background-stronger shrink-0"
                style={
                  settings.appearance.homeBackground()
                    ? { "background-image": `url(${settings.appearance.homeBackground()})` }
                    : {}
                }
              />
              <input
                ref={homeBgInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleHomeBgSelect}
                class="hidden"
              />
              <div class="flex gap-2">
                <Button
                  data-action="settings-home-bg-upload"
                  variant="secondary"
                  size="small"
                  onClick={() => homeBgInput?.click()}
                >
                  Upload
                </Button>
                <Show when={settings.appearance.homeBackground()}>
                  <Button
                    data-action="settings-home-bg-remove"
                    variant="ghost"
                    size="small"
                    onClick={handleHomeBgRemove}
                  >
                    Remove
                  </Button>
                </Show>
              </div>
            </div>
          </SettingsRow>
        </SettingsList>
      </div>
    )
  }

  const NotificationsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.notifications")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const SoundsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.sounds")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <Select
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <Select
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <Select
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const TTS_VOICES = [
    { value: "冰糖", label: "冰糖 (Bīng Táng)" },
    { value: "茉莉", label: "茉莉 (Mò Lì)" },
    { value: "苏打", label: "苏打 (Sū Dǎ)" },
    { value: "白桦", label: "白桦 (Bái Huà)" },
    { value: "Mia", label: "Mia (EN)" },
    { value: "Chloe", label: "Chloe (EN)" },
    { value: "Milo", label: "Milo (EN)" },
    { value: "Dean", label: "Dean (EN)" },
  ]

  const TtsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.tts")}</h3>
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.tts.enabled.title")}
          description={language.t("settings.general.tts.enabled.description")}
        >
          <div data-action="settings-tts-enabled">
            <Switch checked={settings.tts.enabled()} onChange={(checked) => settings.tts.setEnabled(checked)} />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.tts.apiKey.title")}
          description={language.t("settings.general.tts.apiKey.description")}
        >
          <div class="w-full sm:w-[280px]">
            <TextField
              data-action="settings-tts-api-key"
              label={language.t("settings.general.tts.apiKey.title")}
              hideLabel
              type="password"
              value={settings.tts.apiKey()}
              onChange={(value) => settings.tts.setApiKey(value.trim())}
              placeholder={language.t("settings.general.tts.apiKey.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="text-12-regular"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.tts.voice.title")}
          description={language.t("settings.general.tts.voice.description")}
        >
          <Select
            data-action="settings-tts-voice"
            options={TTS_VOICES}
            current={TTS_VOICES.find((v) => v.value === settings.tts.voice()) ?? TTS_VOICES[0]}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && settings.tts.setVoice(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const ProfileSection = () => {
    let userFileInput: HTMLInputElement | undefined
    let assistantFileInput: HTMLInputElement | undefined
    const [userPreview, setUserPreview] = createSignal<string | undefined>(settings.userProfile.avatar() || undefined)
    const [assistantPreview, setAssistantPreview] = createSignal<string | undefined>(
      settings.assistantProfile.avatar() || undefined,
    )

    const handleUserFileSelect = (e: Event) => {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        setUserPreview(dataUrl)
        settings.userProfile.setAvatar(dataUrl)
      }
      reader.readAsDataURL(file)
    }

    const handleUserRemove = () => {
      setUserPreview(undefined)
      settings.userProfile.setAvatar("")
      if (userFileInput) userFileInput.value = ""
    }

    const handleAssistantFileSelect = (e: Event) => {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        setAssistantPreview(dataUrl)
        settings.assistantProfile.setAvatar(dataUrl)
      }
      reader.readAsDataURL(file)
    }

    const handleAssistantRemove = () => {
      setAssistantPreview(undefined)
      settings.assistantProfile.setAvatar("")
      if (assistantFileInput) assistantFileInput.value = ""
    }

    return (
      <div class="flex flex-col gap-3">
        {/* ── User Profile ── */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Profile</h3>
          <SettingsList>
            <SettingsRow title="Display Name" description="Your display name shown in messages">
              <div class="w-full sm:w-[280px]">
                <TextField
                  data-action="settings-profile-name"
                  label="Display Name"
                  hideLabel
                  value={settings.userProfile.displayName()}
                  onChange={(value) => settings.userProfile.setDisplayName(value.trim())}
                  placeholder="Your name"
                  spellcheck={false}
                  autocorrect="off"
                  class="text-12-regular"
                />
              </div>
            </SettingsRow>

            <SettingsRow title="Avatar" description="Custom avatar for your messages">
              <div class="flex items-center gap-3">
                <Avatar
                  fallback={(settings.userProfile.displayName() || "U")[0] || "U"}
                  src={userPreview()}
                  size="medium"
                  background="var(--syntax-property)"
                  foreground="var(--text-on-accent)"
                />
                <input
                  ref={userFileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={handleUserFileSelect}
                  class="hidden"
                />
                <div class="flex gap-2">
                  <Button
                    data-action="settings-avatar-upload"
                    variant="secondary"
                    size="small"
                    onClick={() => userFileInput?.click()}
                  >
                    Upload
                  </Button>
                  <Show when={userPreview()}>
                    <Button
                      data-action="settings-avatar-remove"
                      variant="ghost"
                      size="small"
                      onClick={handleUserRemove}
                    >
                      Remove
                    </Button>
                  </Show>
                </div>
              </div>
            </SettingsRow>
          </SettingsList>
        </div>

        {/* ── Assistant (RedCode) Profile ── */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Assistant Avatar</h3>
          <SettingsList>
            <SettingsRow title="Avatar" description="Custom avatar for RedCode assistant messages">
              <div class="flex items-center gap-3">
                <Avatar
                  fallback="R"
                  src={assistantPreview()}
                  size="medium"
                  background="var(--syntax-keyword)"
                  foreground="var(--text-on-accent)"
                />
                <input
                  ref={assistantFileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={handleAssistantFileSelect}
                  class="hidden"
                />
                <div class="flex gap-2">
                  <Button
                    data-action="settings-assistant-avatar-upload"
                    variant="secondary"
                    size="small"
                    onClick={() => assistantFileInput?.click()}
                  >
                    Upload
                  </Button>
                  <Show when={assistantPreview()}>
                    <Button
                      data-action="settings-assistant-avatar-remove"
                      variant="ghost"
                      size="small"
                      onClick={handleAssistantRemove}
                    >
                      Remove
                    </Button>
                  </Show>
                </div>
              </div>
            </SettingsRow>
          </SettingsList>
        </div>
      </div>
    )
  }

  const UpdatesSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.updates")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.updates.row.startup.title")}
          description={language.t("settings.updates.row.startup.description")}
        >
          <div data-action="settings-updates-startup">
            <Switch
              checked={settings.updates.startup()}
              disabled={!platform.checkUpdate}
              onChange={(checked) => settings.updates.setStartup(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <Button size="small" variant="secondary" disabled={store.checking || !platform.checkUpdate} onClick={check}>
            {store.checking
              ? language.t("settings.updates.action.checking")
              : language.t("settings.updates.action.checkNow")}
          </Button>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const DisplaySection = () => (
    <Show when={desktop()}>
      <div class="flex flex-col gap-1">
        <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.display")}</h3>

        <SettingsList>
          <SettingsRow
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
            </div>
          </SettingsRow>

          <Show when={linux()}>
            <SettingsRow
              title={
                <div class="flex items-center gap-2">
                  <span>{language.t("settings.general.row.wayland.title")}</span>
                  <Tooltip value={language.t("settings.general.row.wayland.tooltip")} placement="top">
                    <span class="text-text-weak">
                      <Icon name="help" size="small" />
                    </span>
                  </Tooltip>
                </div>
              }
              description={language.t("settings.general.row.wayland.description")}
            >
              <div data-action="settings-wayland">
                <Switch checked={displayBackend.latest === "wayland"} onChange={onDisplayBackendChange} />
              </div>
            </SettingsRow>
          </Show>
        </SettingsList>
      </div>
    </Show>
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.general")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <GeneralSection />

        <AppearanceSection />

        <NotificationsSection />

        <SoundsSection />

        <TtsSection />

        <ProfileSection />

        <UpdatesSection />

        <DisplaySection />

        <AdvancedSection />
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
