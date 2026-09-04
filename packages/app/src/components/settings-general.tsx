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
import { SettingsList, SettingsRow } from "./settings-list"

// 候选列表来自系统枚举，字体本机一定有，不存在回退到默认字体的误判
const isMonospace = (font: string) => {
  const ctx = document.createElement("canvas").getContext("2d")
  if (!ctx) return false
  ctx.font = `72px "${font}"`
  return ctx.measureText("MMMMMMMMMM").width === ctx.measureText("iiiiiiiiii").width
}

const splitFontWidths = (all: string[]) => ({ all, mono: all.filter(isMonospace) })

/** 字体下拉的「默认」哨兵：字体名不可能长这样（无下划线字体），选它=清除配置回到系统默认 */
const FONT_UNDEFINED = "__default__"

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

  // 260829 Red 字体输入配 datalist 候选：枚举本机字体，等宽的那份只给代码/终端用
  const [fonts] = createResource(
    () => (desktop() && platform.listFonts ? true : false),
    () =>
      Promise.resolve(platform.listFonts?.() ?? [])
        .then(splitFontWidths)
        .catch(() => ({ all: [] as string[], mono: [] as string[] })),
    { initialValue: { all: [] as string[], mono: [] as string[] } },
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

  // 260903 cc 生图后端。预设只是把 baseURL+model 一次填好的快捷方式，两个字段本身
  //   始终可编辑 —— 换供应商是改配置不是改代码，这正是它存在的理由。
  //   密钥不在这里填：走 auth（provider 字段指哪个条目）或 REDCODE_IMAGE_API_KEY，
  //   免得把密钥写进会被同步、被分享的配置文件。
  const IMAGE_PRESETS = [
    {
      id: "stepfun",
      label: "StepFun Step Plan",
      provider: "step_plan",
      baseURL: "https://api.stepfun.com/step_plan/v1",
      model: "step-image-edit-2",
    },
    {
      id: "openai",
      label: "OpenAI",
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-image-1",
    },
  ] as const
  const currentImage = createMemo(() => globalSync.data.config.image ?? {})
  const currentImagePreset = createMemo(
    () => IMAGE_PRESETS.find((preset) => preset.baseURL === currentImage().baseURL)?.id ?? "custom",
  )
  const imagePresetOptions = createMemo(() => [
    ...IMAGE_PRESETS.map((preset) => ({ value: preset.id as string, label: preset.label })),
    { value: "custom", label: language.t("settings.general.row.image.custom") },
  ])
  const patchImage = (patch: Record<string, string | undefined>) =>
    globalSync.updateConfig({ image: { ...currentImage(), ...patch } })

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
          title={language.t("settings.general.row.image.title")}
          description={language.t("settings.general.row.image.description")}
        >
          <Select
            data-action="settings-image-preset"
            options={imagePresetOptions()}
            current={imagePresetOptions().find((o) => o.value === currentImagePreset())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option || option.value === "custom") return
              const preset = IMAGE_PRESETS.find((item) => item.id === option.value)
              if (!preset) return
              patchImage({ provider: preset.provider, baseURL: preset.baseURL, model: preset.model })
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.imageEndpoint.title")}
          description={language.t("settings.general.row.imageEndpoint.description")}
        >
          <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "min-width": "320px" }}>
            <TextField
              name="image-base-url"
              value={currentImage().baseURL ?? ""}
              placeholder="https://api.stepfun.com/step_plan/v1"
              onChange={(value) => patchImage({ baseURL: value.trim() || undefined })}
            />
            <TextField
              name="image-model"
              value={currentImage().model ?? ""}
              placeholder="step-image-edit-2"
              onChange={(value) => patchImage({ model: value.trim() || undefined })}
            />
            <TextField
              name="image-provider"
              value={currentImage().provider ?? ""}
              placeholder="step_plan"
              onChange={(value) => patchImage({ provider: value.trim() || undefined })}
            />
          </div>
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

          {(() => {
            // 260829 Red 字体选择改自定义下拉：每项以自身字体渲染预览，交互走 Kobalte 弹层
            // （原生 datalist 样式不可控、点输入框不弹、点按钮收不回——哥哥实测三连败）
            const fontItem = (kind: "sans" | "mono") => (font: string | undefined) => {
              if (font === FONT_UNDEFINED)
                return <span>{language.t("settings.general.row.font.undefined")}</span>
              if (!font) return null
              return (
                <span style={{ "font-family": `"${font}", ${kind === "sans" ? "sans-serif" : "monospace"}` }}>
                  {font}
                </span>
              )
            }
            const fontOptions = (list: readonly string[]) => [FONT_UNDEFINED, ...list]
            return (
              <>
                <SettingsRow
                  title={language.t("settings.general.row.uiFont.title")}
                  description={language.t("settings.general.row.uiFont.description")}
                >
                  <Select
                    data-action="settings-ui-font"
                    options={fontOptions(fonts().all)}
                    current={sans() || undefined}
                    value={(f) => f}
                    label={(f) => (f === FONT_UNDEFINED ? language.t("settings.general.row.font.undefined") : f)}
                    onSelect={(f) => {
                      if (f) settings.appearance.setUIFont(f === FONT_UNDEFINED ? "" : f)
                    }}
                    placeholder={sansDefault}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                    triggerStyle={{ "min-width": "180px" }}
                  >
                    {fontItem("sans")}
                  </Select>
                </SettingsRow>

                <SettingsRow
                  title={language.t("settings.general.row.font.title")}
                  description={language.t("settings.general.row.font.description")}
                >
                  <Select
                    data-action="settings-code-font"
                    options={fontOptions(fonts().mono)}
                    current={mono() || undefined}
                    value={(f) => f}
                    label={(f) => (f === FONT_UNDEFINED ? language.t("settings.general.row.font.undefined") : f)}
                    onSelect={(f) => {
                      if (f) settings.appearance.setFont(f === FONT_UNDEFINED ? "" : f)
                    }}
                    placeholder={monoDefault}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                    triggerStyle={{ "min-width": "180px" }}
                  >
                    {fontItem("mono")}
                  </Select>
                </SettingsRow>

                <SettingsRow
                  title={language.t("settings.general.row.terminalFont.title")}
                  description={language.t("settings.general.row.terminalFont.description")}
                >
                  <Select
                    data-action="settings-terminal-font"
                    options={fontOptions(fonts().mono)}
                    current={terminal() || undefined}
                    value={(f) => f}
                    label={(f) => (f === FONT_UNDEFINED ? language.t("settings.general.row.font.undefined") : f)}
                    onSelect={(f) => {
                      if (f) settings.appearance.setTerminalFont(f === FONT_UNDEFINED ? "" : f)
                    }}
                    placeholder={terminalDefault}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                    triggerStyle={{ "min-width": "180px" }}
                  >
                    {fontItem("mono")}
                  </Select>
                </SettingsRow>

                {/* 260830 Red 字体大小：fontSize 此前是死配置（储存≠生效），这里接线 UI 供调节 */}
                <SettingsRow
                  title={language.t("settings.general.row.fontSize.title")}
                  description={language.t("settings.general.row.fontSize.description")}
                >
                  <Select
                    data-action="settings-font-size"
                    options={["12", "13", "14", "15", "16", "17", "18", "20"]}
                    current={String(settings.appearance.fontSize())}
                    value={(f) => f}
                    label={(f) => `${f}px`}
                    onSelect={(f) => {
                      if (f) settings.appearance.setFontSize(Number(f))
                    }}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                    triggerStyle={{ "min-width": "72px" }}
                  />
                </SettingsRow>
              </>
            )
          })()}

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
      </div>
    </div>
  )
}
