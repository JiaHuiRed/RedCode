import { Component, Show, createMemo, createResource, createSignal, onMount, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@redcode-ai/ui/button"
import { Avatar } from "@redcode-ai/ui/avatar"
import { Icon } from "@redcode-ai/ui/icon"
import { Select } from "@redcode-ai/ui/select"
import { Switch } from "@redcode-ai/ui/switch"
import { TextField } from "@redcode-ai/ui/text-field"
import { Tooltip } from "@redcode-ai/ui/tooltip"
import { requestSpeech, SPEECH_VOICES, speechErrorKey } from "@redcode-ai/ui/speech"
import { useTheme, type ColorScheme } from "@redcode-ai/ui/theme/context"
import { showToast } from "@redcode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
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
import { AppearanceSamples } from "@/components/settings-appearance-preview"
import { Link } from "./link"
import { SettingsList, SettingsRow } from "./settings-list"
import { SettingsMobileCompanion } from "./settings-mobile-companion"

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

export type GeneralSettingsSection = "general" | "appearance" | "sound" | "devices" | "updates" | "tools"

export const SettingsGeneral: Component<{ section?: GeneralSettingsSection }> = (props) => {
  const section = () => props.section ?? "general"
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const params = useParams()
  const settings = useSettings()

  const [store, setStore] = createStore({
    checking: false,
    // 261116 Red 更新状态单列：检查中/禁用/无新版/有新版/失败 不能都塌缩成「已是最新版」
    updateStatus: "idle" as "idle" | "disabled" | "up-to-date" | "available" | "failed",
    updateVersion: undefined as string | undefined,
    speech: "idle" as "idle" | "loading" | "playing",
    savingConfig: false,
    threshold: undefined as string | undefined,
    installing: false,
    installError: undefined as string | undefined,
  })

  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const dir = createMemo(() => decode64(params.dir))
  const desktop = createMemo(() => platform.platform === "desktop")

  const exportLogs = () => {
    void platform.exportDebugLogs?.().catch((error: unknown) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const updateFailureActions = (retry: () => void) => {
    const actions: { label: string; onClick: () => void }[] = [{ label: language.t("common.retry"), onClick: retry }]
    if (platform.exportDebugLogs) {
      actions.push({ label: language.t("error.page.action.exportLogs"), onClick: exportLogs })
    }
    return actions
  }

  // 261116 Red 失败必须可重试、可取证：toast 带「重试」和日志导出入口，原始错误原样显示
  const showUpdateFailure = (kind: "check" | "install", error: string | undefined, retry: () => void) => {
    const title =
      kind === "check" ? "settings.updates.toast.failed.title" : "settings.updates.toast.downloadFailed.title"
    const description =
      kind === "check"
        ? "settings.updates.toast.failed.description"
        : "settings.updates.toast.downloadFailed.description"
    const message = language.t(description)
    showToast({
      persistent: true,
      variant: "error",
      icon: "circle-x",
      title: language.t(title),
      description: error ? `${message} ${error}` : message,
      actions: updateFailureActions(retry),
    })
  }

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)
    setStore("installError", undefined)

    void platform
      .checkUpdate()
      .then((result) => {
        setStore("updateVersion", result.version)
        const status = result.status ?? (result.updateAvailable ? "available" : "failed")
        setStore("updateStatus", status)
        if (status === "failed") {
          showUpdateFailure("check", result.error, check)
          return
        }
        if (status === "disabled") {
          showToast({
            title: language.t("settings.updates.toast.disabled.title"),
            description: language.t("settings.updates.toast.disabled.description"),
          })
          return
        }
        if (status !== "available") {
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
                onClick: install,
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
        setStore("updateStatus", "failed")
        showUpdateFailure("check", message, check)
      })
      .finally(() => setStore("checking", false))
  }

  const install = () => {
    const updateAndRestart = platform.updateAndRestart
    if (!updateAndRestart || store.installing) return
    setStore("installing", true)
    setStore("installError", undefined)

    void updateAndRestart()
      .then((result) => {
        if (result.status === "failed") {
          setStore("installError", result.error)
          if (result.reason === "check") {
            setStore("updateStatus", "failed")
            showUpdateFailure("check", result.error, check)
            return
          }
          showUpdateFailure("install", result.error, install)
          return
        }
        if (result.status === "skipped") {
          setStore("updateStatus", result.reason === "disabled" ? "disabled" : "up-to-date")
          showToast(
            result.reason === "disabled"
              ? {
                  title: language.t("settings.updates.toast.disabled.title"),
                  description: language.t("settings.updates.toast.disabled.description"),
                }
              : {
                  title: language.t("settings.updates.toast.latest.title"),
                  description: language.t("settings.updates.toast.latest.description", {
                    version: platform.version ?? "",
                  }),
                },
          )
          return
        }
        showToast({
          icon: "download",
          title: language.t("settings.updates.toast.downloaded.title"),
          description: language.t("settings.updates.toast.downloaded.description"),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setStore("installError", message)
        showUpdateFailure("install", message, install)
      })
      .finally(() => setStore("installing", false))
  }

  const updateDescription = () => {
    const base = language.t("settings.updates.row.check.description")
    if (store.installError) return `${base} ${language.t("settings.updates.toast.downloadFailed.title")}`
    if (store.updateStatus === "available") {
      return `${base} ${language.t("settings.updates.status.available", { version: store.updateVersion ?? "" })}`
    }
    if (store.updateStatus === "failed") return `${base} ${language.t("settings.updates.toast.failed.title")}`
    if (store.updateStatus === "disabled") return language.t("settings.updates.toast.disabled.description")
    if (store.updateStatus === "up-to-date") return language.t("settings.updates.toast.latest.title")
    return base
  }

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  const globalSync = useServerSync()
  const globalSdk = useGlobalSDK()

  const [shells, { refetch: refetchShells }] = createResource(
    () => section() === "tools",
    () => globalSdk.client.pty.shells().then((res) => res.data ?? []),
    { initialValue: [] as ShellOption[] },
  )

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => (section() === "appearance" && desktop() && platform.getPinchZoomEnabled ? true : false),
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )

  // 260829 Red 字体输入配 datalist 候选：枚举本机字体，等宽的那份只给代码/终端用
  const [fonts] = createResource(
    () => (section() === "appearance" && desktop() && platform.listFonts ? true : false),
    () =>
      Promise.resolve(platform.listFonts?.() ?? [])
        .then(splitFontWidths)
        .catch(() => ({ all: [] as string[], mono: [] as string[] })),
    { initialValue: { all: [] as string[], mono: [] as string[] } },
  )

  onMount(() => {
    void theme.loadThemes()
  })

  const saveConfig = async (patch: Parameters<typeof globalSync.updateConfig>[0]) => {
    if (store.savingConfig) return
    setStore("savingConfig", true)
    try {
      await globalSync.updateConfig(patch)
      return true
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStore("savingConfig", false)
    }
  }

  const autoOption = { id: "auto", value: "", label: language.t("settings.general.row.shell.autoDefault") }
  const currentShell = createMemo(() => globalSync.data.config.shell ?? "")

  const currentNotice = createMemo(() => globalSync.data.config.verification?.notice ?? "failure")
  const noticeOptions = createMemo<{ value: "failure" | "always" | "off"; label: string }[]>(() => [
    { value: "failure", label: language.t("settings.general.row.verificationNotice.option.failure") },
    { value: "always", label: language.t("settings.general.row.verificationNotice.option.always") },
    { value: "off", label: language.t("settings.general.row.verificationNotice.option.off") },
  ])

  const shellOptions = createMemo<ShellSelectOption[]>(() => {
    const list = shells.error ? [] : shells.latest
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

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch((error: unknown) => {
      setPinchZoom(!checked)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

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
          title={language.t("settings.modern.progress.title")}
          description={language.t("settings.modern.progress.description")}
        >
          <Switch
            checked={settings.general.showSessionProgressBar()}
            onChange={settings.general.setShowSessionProgressBar}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.petEnabled.title")}
          description={language.t("settings.general.row.petEnabled.description")}
        >
          <div data-action="settings-pet-enabled">
            <Switch
              checked={settings.general.petEnabled()}
              onChange={(checked) => settings.general.setPetEnabled(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const ToolsSection = () => (
    <section class="settings-section">
      <div>
        <h3 class="settings-section-title">{language.t("settings.modern.codeTools.title")}</h3>
        <p class="settings-page-description">{language.t("settings.modern.codeTools.description")}</p>
      </div>
      <Show when={shells.error}>
        <div class="settings-inline-actions settings-error" role="status">
          {language.t("common.requestFailed")}
          <Button size="small" variant="ghost" onClick={() => void refetchShells()}>
            {language.t("common.retry")}
          </Button>
        </div>
      </Show>
      <SettingsList>
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
              void saveConfig({ shell: option.value })
            }}
            disabled={store.savingConfig}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.verificationNotice.title")}
          description={language.t("settings.general.row.verificationNotice.description")}
        >
          <Select
            data-action="settings-verification-notice"
            options={noticeOptions()}
            current={noticeOptions().find((o) => o.value === currentNotice()) ?? noticeOptions()[0]}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option || option.value === currentNotice()) return
              void saveConfig({ verification: { notice: option.value } })
            }}
            disabled={store.savingConfig}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.modern.agentShell.title")}
          description={language.t("settings.modern.agentShell.description")}
        >
          <Select
            options={["legacy", "git-bash", "powershell"] as const}
            current={globalSync.data.config.shellRouting?.agentDefault ?? "legacy"}
            label={(value) =>
              value === "legacy"
                ? language.t("settings.modern.agentShell.legacy")
                : value === "git-bash"
                  ? "Git Bash"
                  : "PowerShell"
            }
            onSelect={(value) => value && void saveConfig({ shellRouting: { agentDefault: value } })}
            disabled={store.savingConfig}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.modern.verification.title")}
          description={language.t("settings.modern.verification.description")}
        >
          <Switch
            checked={globalSync.data.config.verification?.enabled !== false}
            disabled={store.savingConfig}
            onChange={(enabled) => void saveConfig({ verification: { enabled } })}
          />
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.modern.snapshot.title")}
          description={language.t("settings.modern.snapshot.description")}
        >
          <Switch
            checked={globalSync.data.config.snapshot !== false}
            disabled={store.savingConfig}
            onChange={(snapshot) => void saveConfig({ snapshot })}
          />
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.modern.compaction.title")}
          description={language.t("settings.modern.compaction.description")}
        >
          <Switch
            checked={globalSync.data.config.compaction?.auto !== false}
            disabled={store.savingConfig}
            onChange={(auto) => void saveConfig({ compaction: { auto } })}
          />
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.modern.compaction.prune.title")}
          description={language.t("settings.modern.compaction.prune.description")}
        >
          <Switch
            checked={globalSync.data.config.compaction?.prune === true}
            disabled={store.savingConfig}
            onChange={(prune) => void saveConfig({ compaction: { prune } })}
          />
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.modern.compaction.threshold.title")}
          description={language.t("settings.modern.compaction.threshold.description")}
        >
          <div class="settings-inline-actions">
            <TextField
              type="number"
              disabled={store.savingConfig}
              min="0"
              step="1000"
              value={store.threshold ?? String(globalSync.data.config.compaction?.threshold ?? 0)}
              onChange={(value) => setStore("threshold", value)}
              class="w-28"
            />
            <Button
              size="small"
              variant="secondary"
              disabled={store.savingConfig || store.threshold === undefined}
              onClick={() => {
                const threshold = Number(store.threshold)
                if (!Number.isSafeInteger(threshold) || threshold < 0) {
                  showToast({ variant: "error", title: language.t("settings.modern.compaction.threshold.invalid") })
                  return
                }
                void saveConfig({ compaction: { threshold } }).then((saved) => {
                  if (saved) setStore("threshold", undefined)
                })
              }}
            >
              {language.t("settings.modern.save")}
            </Button>
          </div>
        </SettingsRow>
      </SettingsList>
    </section>
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
        <h3 data-settings-anchor="appearance" class="text-14-medium text-text-strong pb-2">
          {language.t("settings.general.section.appearance")}
        </h3>

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
              if (font === FONT_UNDEFINED) return <span>{language.t("settings.general.row.font.undefined")}</span>
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

          <SettingsRow
            title={language.t("settings.general.row.chatBackground.title")}
            description={language.t("settings.general.row.chatBackground.description")}
          >
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
                  {language.t("settings.general.action.upload")}
                </Button>
                <Show when={settings.appearance.chatBackground()}>
                  <Button
                    data-action="settings-chat-bg-remove"
                    variant="ghost"
                    size="small"
                    onClick={handleChatBgRemove}
                  >
                    {language.t("settings.general.action.remove")}
                  </Button>
                </Show>
              </div>
            </div>
          </SettingsRow>

          {/* 261109 Karina UX-08：壁纸遮罩可调——壁纸偏亮/复杂时把正文区域压下去，
              设置立即生效并持久化；0% 保留原图观感。 */}
          <SettingsRow
            title={language.t("settings.general.row.wallpaperDim.title")}
            description={language.t("settings.general.row.wallpaperDim.description")}
          >
            <div class="flex items-center gap-3">
              <input
                data-action="settings-wallpaper-dim"
                aria-label={language.t("settings.general.row.wallpaperDim.title")}
                aria-valuetext={`${settings.appearance.wallpaperDim()}%`}
                type="range"
                min="0"
                max="60"
                step="2"
                value={settings.appearance.wallpaperDim()}
                onInput={(event) => settings.appearance.setWallpaperDim(Number(event.currentTarget.value))}
                class="w-40"
              />
              <span class="w-9 shrink-0 text-right text-[11px] tabular-nums text-text-weak">
                {settings.appearance.wallpaperDim()}%
              </span>
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.homeBackground.title")}
            description={language.t("settings.general.row.homeBackground.description")}
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
                  {language.t("settings.general.action.upload")}
                </Button>
                <Show when={settings.appearance.homeBackground()}>
                  <Button
                    data-action="settings-home-bg-remove"
                    variant="ghost"
                    size="small"
                    onClick={handleHomeBgRemove}
                  >
                    {language.t("settings.general.action.remove")}
                  </Button>
                </Show>
              </div>
            </div>
          </SettingsRow>
        </SettingsList>

        {/* 261115 Red UX-20：外观实时样例——消息/代码/终端三块与主界面同一套
            token 与壁纸遮罩规则，上方调整即时反映；含本次外观改动的局部撤销。 */}
        <AppearanceSamples />
      </div>
    )
  }

  const NotificationsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 data-settings-anchor="notifications" class="text-14-medium text-text-strong pb-2">
        {language.t("settings.general.section.notifications")}
      </h3>

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
      <h3 data-settings-anchor="sounds" class="text-14-medium text-text-strong pb-2">
        {language.t("settings.general.section.sounds")}
      </h3>

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

  let speechAudio: HTMLAudioElement | undefined
  let speechURL: string | undefined
  let speechRequest: AbortController | undefined
  const stopSpeech = () => {
    speechRequest?.abort()
    speechRequest = undefined
    if (speechAudio) {
      speechAudio.onended = null
      speechAudio.onerror = null
      speechAudio.pause()
      speechAudio = undefined
    }
    if (speechURL) URL.revokeObjectURL(speechURL)
    speechURL = undefined
    setStore("speech", "idle")
  }
  onCleanup(() => {
    stopSpeech()
    stopDemoSound()
  })
  const previewSpeech = async () => {
    if (store.speech !== "idle") {
      stopSpeech()
      return
    }
    const controller = new AbortController()
    speechRequest = controller
    setStore("speech", "loading")
    try {
      const blob = await requestSpeech({
        apiKey: settings.tts.apiKey(),
        voice: settings.tts.voice(),
        text: language.t("settings.modern.speech.sample"),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      speechURL = URL.createObjectURL(blob)
      speechAudio = new Audio(speechURL)
      speechAudio.onended = stopSpeech
      speechAudio.onerror = () => {
        showToast({
          variant: "error",
          title: language.t("settings.modern.speech.failed"),
          description: language.t("ui.speech.error.playback"),
        })
        stopSpeech()
      }
      await speechAudio.play()
      if (!controller.signal.aborted) setStore("speech", "playing")
    } catch (error) {
      if (controller.signal.aborted) return
      showToast({
        variant: "error",
        title: language.t("settings.modern.speech.failed"),
        description: language.t(speechErrorKey(error)),
      })
      stopSpeech()
    }
  }

  const TtsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 data-settings-anchor="tts" class="text-14-medium text-text-strong pb-2">
        {language.t("settings.general.section.tts")}
      </h3>
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
            options={SPEECH_VOICES}
            current={SPEECH_VOICES.find((v) => v.value === settings.tts.voice()) ?? SPEECH_VOICES[0]}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && settings.tts.setVoice(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.modern.speech.preview")}
          description={language.t("settings.modern.speech.description")}
        >
          <Button
            size="small"
            variant="secondary"
            onClick={() => void previewSpeech()}
            data-action="settings-speech-preview"
          >
            {language.t(
              store.speech === "idle"
                ? "settings.modern.speech.preview"
                : store.speech === "loading"
                  ? "settings.modern.speech.cancel"
                  : "settings.modern.speech.stop",
            )}
          </Button>
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
          <h3 data-settings-anchor="profile" class="text-14-medium text-text-strong pb-2">
            {language.t("settings.general.section.profile")}
          </h3>
          <p class="settings-page-description mb-3">{language.t("settings.modern.profile.description")}</p>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.general.row.displayName.title")}
              description={language.t("settings.general.row.displayName.description")}
            >
              <div class="w-full sm:w-[280px]">
                <TextField
                  data-action="settings-profile-name"
                  label={language.t("settings.general.row.displayName.title")}
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

            <SettingsRow
              title={language.t("settings.general.row.avatar.title")}
              description={language.t("settings.general.row.avatar.description")}
            >
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
                    {language.t("settings.general.action.upload")}
                  </Button>
                  <Show when={userPreview()}>
                    <Button
                      data-action="settings-avatar-remove"
                      variant="ghost"
                      size="small"
                      onClick={handleUserRemove}
                    >
                      {language.t("settings.general.action.remove")}
                    </Button>
                  </Show>
                </div>
              </div>
            </SettingsRow>
          </SettingsList>
        </div>

        {/* ── Assistant (RedCode) Profile ── */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.assistantAvatar")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.general.row.assistantAvatar.title")}
              description={language.t("settings.general.row.assistantAvatar.description")}
            >
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
                    {language.t("settings.general.action.upload")}
                  </Button>
                  <Show when={assistantPreview()}>
                    <Button
                      data-action="settings-assistant-avatar-remove"
                      variant="ghost"
                      size="small"
                      onClick={handleAssistantRemove}
                    >
                      {language.t("settings.general.action.remove")}
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
      <h3 data-settings-anchor="updates" class="text-14-medium text-text-strong pb-2">
        {language.t("settings.general.section.updates")}
      </h3>

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

        <SettingsRow title={language.t("settings.updates.row.check.title")} description={updateDescription()}>
          <div class="flex items-center gap-2" data-action="settings-updates-check">
            <Show when={store.updateStatus === "available" && platform.updateAndRestart}>
              <Button size="small" variant="primary" disabled={store.installing} onClick={install}>
                {store.installing
                  ? language.t("settings.updates.action.downloading")
                  : language.t("toast.update.action.installRestart")}
              </Button>
            </Show>
            <Button size="small" variant="secondary" disabled={store.checking || !platform.checkUpdate} onClick={check}>
              {store.checking
                ? language.t("settings.updates.action.checking")
                : language.t("settings.updates.action.checkNow")}
            </Button>
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const DisplaySection = () => (
    <Show when={desktop()}>
      <div class="flex flex-col gap-1">
        <h3 data-settings-anchor="display" class="text-14-medium text-text-strong pb-2">
          {language.t("settings.general.section.display")}
        </h3>

        <SettingsList>
          <SettingsRow
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
            </div>
          </SettingsRow>
        </SettingsList>
      </div>
    </Show>
  )

  const heading = () => {
    if (section() === "appearance") return language.t("settings.modern.appearance")
    if (section() === "sound") return language.t("settings.modern.sound")
    if (section() === "devices") return language.t("settings.modern.devices")
    return language.t("settings.tab.general")
  }
  const description = () => {
    if (section() === "appearance") return language.t("settings.modern.appearance.description")
    if (section() === "sound") return language.t("settings.modern.sound.description")
    if (section() === "devices") return language.t("settings.modern.devices.description")
    return language.t("settings.modern.general.description")
  }

  return (
    <div class={section() === "tools" ? "settings-section" : "settings-page-body"}>
      <Show when={section() !== "tools" && section() !== "updates"}>
        <header class="settings-page-heading">
          <div>
            <h2 class="settings-page-title">{heading()}</h2>
            <p class="settings-page-description">{description()}</p>
          </div>
          <span class="settings-scope">{language.t("settings.modern.scope.local")}</span>
        </header>
      </Show>
      <Show when={section() === "general"}>
        <GeneralSection />
        <ProfileSection />
      </Show>
      <Show when={section() === "appearance"}>
        <AppearanceSection />
        <DisplaySection />
      </Show>
      <Show when={section() === "sound"}>
        <NotificationsSection />
        <SoundsSection />
        <TtsSection />
      </Show>
      <Show when={section() === "devices"}>
        <Show
          when={desktop() && !!platform.getMobileGatewayStatus}
          fallback={<p class="settings-empty">{language.t("settings.modern.devices.desktopOnly")}</p>}
        >
          <SettingsMobileCompanion directory={dir()} sessionID={params.id} />
        </Show>
      </Show>
      <Show when={section() === "updates"}>
        <UpdatesSection />
      </Show>
      <Show when={section() === "tools"}>
        <ToolsSection />
      </Show>
    </div>
  )
}
