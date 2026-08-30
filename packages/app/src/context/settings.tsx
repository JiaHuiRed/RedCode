import { createStore, reconcile } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { createSimpleContext } from "@redcode-ai/ui/context"
import { persisted } from "@/utils/persist"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export interface TtsSettings {
  apiKey: string
  voice: string
  enabled: boolean
}

export interface UserProfile {
  avatar: string
  displayName: string
}

export interface Settings {
  general: {
    releaseNotes: boolean
    followup: "queue" | "steer"
    showReasoningSummaries: boolean
    shellToolPartsExpanded: boolean
    editToolPartsExpanded: boolean
    showSessionProgressBar: boolean
  }
  updates: {
    startup: boolean
  }
  appearance: {
    fontSize: number
    mono: string
    sans: string
    terminal: string
    // 260608 Red 0.4.5 微信风聊天背景图：data URL（""=无），全局生效
    chatBackground: string
    // 260610 Red 0.5.0 主界面（首页/无会话）背景图：data URL（""=无），与聊天背景独立，便于公司/家里分别换壁纸
    homeBackground: string
  }
  keybinds: Record<string, string>
  notifications: NotificationSettings
  sounds: SoundSettings
  tts: TtsSettings
  userProfile: UserProfile
  assistantProfile: UserProfile
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined) {
  return stack(font, terminalBase)
}

const defaultSettings: Settings = {
  general: {
    releaseNotes: true,
    followup: "steer",
    // 260830 Red 思考链对齐 TUI hide 模式：默认显示折叠行（可点击展开），不再默认隐藏
    showReasoningSummaries: true,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showSessionProgressBar: true,
  },
  updates: {
    startup: true,
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
    chatBackground: "",
    homeBackground: "",
  },
  keybinds: {},
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
  tts: {
    apiKey: "",
    voice: "冰糖",
    enabled: false,
  },
  userProfile: {
    avatar: "",
    displayName: "",
  },
  assistantProfile: {
    avatar: "",
    displayName: "RedCode",
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  init: () => {
    const [store, setStore, _, ready] = persisted("settings.v3", createStore<Settings>(defaultSettings))

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono))
      root.style.setProperty("--font-family-sans", sansFontFamily(store.appearance?.sans))
      // 260830 Red 字体大小生效：--font-size-* 按外观配置等比缩放（基准 14px）。
      // 此前 fontSize 是死配置——储存、有读写、有 setFontSize，但没有任何消费点。
      const scale = (store.appearance?.fontSize ?? 14) / 14
      const px = (base: number) => `${Math.round(base * scale * 100) / 100}px`
      root.style.setProperty("--font-size-small", px(13))
      root.style.setProperty("--font-size-base", px(14))
      root.style.setProperty("--font-size-large", px(16))
      root.style.setProperty("--font-size-x-large", px(20))
    })

    createEffect(() => {
      if (store.general?.followup !== "queue") return
      setStore("general", "followup", "steer")
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
        followup: withFallback(
          () => (store.general?.followup === "queue" ? "steer" : store.general?.followup),
          defaultSettings.general.followup,
        ),
        setFollowup(value: "queue" | "steer") {
          setStore("general", "followup", value === "queue" ? "steer" : value)
        },
        showReasoningSummaries: withFallback(
          () => store.general?.showReasoningSummaries,
          defaultSettings.general.showReasoningSummaries,
        ),
        setShowReasoningSummaries(value: boolean) {
          setStore("general", "showReasoningSummaries", value)
        },
        shellToolPartsExpanded: withFallback(
          () => store.general?.shellToolPartsExpanded,
          defaultSettings.general.shellToolPartsExpanded,
        ),
        setShellToolPartsExpanded(value: boolean) {
          setStore("general", "shellToolPartsExpanded", value)
        },
        editToolPartsExpanded: withFallback(
          () => store.general?.editToolPartsExpanded,
          defaultSettings.general.editToolPartsExpanded,
        ),
        setEditToolPartsExpanded(value: boolean) {
          setStore("general", "editToolPartsExpanded", value)
        },
        showSessionProgressBar: withFallback(
          () => store.general?.showSessionProgressBar,
          defaultSettings.general.showSessionProgressBar,
        ),
        setShowSessionProgressBar(value: boolean) {
          setStore("general", "showSessionProgressBar", value)
        },
      },
      updates: {
        startup: withFallback(() => store.updates?.startup, defaultSettings.updates.startup),
        setStartup(value: boolean) {
          setStore("updates", "startup", value)
        },
      },
      appearance: {
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setStore("appearance", "terminal", value.trim() ? value : "")
        },
        chatBackground: withFallback(() => store.appearance?.chatBackground, defaultSettings.appearance.chatBackground),
        setChatBackground(value: string) {
          setStore("appearance", "chatBackground", value)
        },
        homeBackground: withFallback(() => store.appearance?.homeBackground, defaultSettings.appearance.homeBackground),
        setHomeBackground(value: string) {
          setStore("appearance", "homeBackground", value)
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      tts: {
        apiKey: withFallback(() => store.tts?.apiKey, defaultSettings.tts.apiKey),
        setApiKey(value: string) {
          setStore("tts", "apiKey", value)
        },
        voice: withFallback(() => store.tts?.voice, defaultSettings.tts.voice),
        setVoice(value: string) {
          setStore("tts", "voice", value)
        },
        enabled: withFallback(() => store.tts?.enabled, defaultSettings.tts.enabled),
        setEnabled(value: boolean) {
          setStore("tts", "enabled", value)
        },
      },
      sounds: {
        agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
        setAgentEnabled(value: boolean) {
          setStore("sounds", "agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissionsEnabled: withFallback(
          () => store.sounds?.permissionsEnabled,
          defaultSettings.sounds.permissionsEnabled,
        ),
        setPermissionsEnabled(value: boolean) {
          setStore("sounds", "permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
      userProfile: {
        avatar: withFallback(() => store.userProfile?.avatar, defaultSettings.userProfile.avatar),
        setAvatar(value: string) {
          setStore("userProfile", "avatar", value)
        },
        displayName: withFallback(() => store.userProfile?.displayName, defaultSettings.userProfile.displayName),
        setDisplayName(value: string) {
          setStore("userProfile", "displayName", value)
        },
      },
      assistantProfile: {
        avatar: withFallback(() => store.assistantProfile?.avatar, defaultSettings.assistantProfile.avatar),
        setAvatar(value: string) {
          setStore("assistantProfile", "avatar", value)
        },
        displayName: withFallback(
          () => store.assistantProfile?.displayName,
          defaultSettings.assistantProfile.displayName,
        ),
        setDisplayName(value: string) {
          setStore("assistantProfile", "displayName", value)
        },
      },
    }
  },
})
