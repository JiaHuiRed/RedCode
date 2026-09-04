import { createStore, reconcile } from "solid-js/store"
import { createEffect, createMemo, untrack } from "solid-js"
import { createSimpleContext } from "@redcode-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"

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

/**
 * 260904 cc 从 Settings 拆出去的大块二进制：头像与壁纸，都是 data URL。
 * 存在自己的 `RedCode.media.dat` 里（`Persist.media`），不跟高频的小设置同文件。
 * 字段名刻意扁平——它们在 Settings 里分属 appearance / userProfile / assistantProfile 三处，
 * 拍平之后这个 store 只有一层，搬家与读写都不用关心嵌套。
 */
export interface SettingsMedia {
  chatBackground: string
  homeBackground: string
  userAvatar: string
  assistantAvatar: string
}

const defaultMedia: SettingsMedia = {
  chatBackground: "",
  homeBackground: "",
  userAvatar: "",
  assistantAvatar: "",
}

const MEDIA_KEYS = ["chatBackground", "homeBackground", "userAvatar", "assistantAvatar"] as const

/**
 * 存量搬家的决策：给定旧 `settings.v3` 里那四个字段的现值与 media store 的现状，
 * 算出该写哪些、该清哪些。
 *
 * 抽成纯函数是为了能单独测——这段只在启动瞬间跑一次，错了用户看到的是「头像和壁纸没了」，
 * 而且旧值已被清掉、找不回来。两条规则：
 *   · media 已有值就**不覆盖**——说明搬过了，用户此后可能又换过图，旧值是陈的
 *   · 只要旧字段有值就**一定清**（不管有没有写）——不清等于留两份，`default.dat` 不会瘦
 */
export function planMediaMigration(input: {
  legacy: Partial<Record<keyof SettingsMedia, string | undefined>>
  media: SettingsMedia
}) {
  const write: Array<[keyof SettingsMedia, string]> = []
  const clear: Array<keyof SettingsMedia> = []
  for (const key of MEDIA_KEYS) {
    const value = input.legacy[key]
    if (!value) continue
    if (!input.media[key]) write.push([key, value])
    clear.push(key)
  }
  return { write, clear }
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
    // 260904 cc 四张 base64 图挪进自己的存储文件，理由见 Persist.media 的注释（一句话：
    // 写穿 + 主进程整文件读写，让改字号也要搬 3.4MB）。Settings 类型里那四个字段**保留**，
    // 上层组件与设置页一行都不用改——变的只是这几个 accessor 从哪个 store 取值。
    const [media, setMedia, __, mediaReady] = persisted(
      Persist.media("settings.media.v1"),
      createStore<SettingsMedia>({ ...defaultMedia }),
    )

    // 存量搬家，两个 store 都就绪后跑一次。决策在 planMediaMigration 里（有单测）。
    const clearLegacy: Record<keyof SettingsMedia, () => void> = {
      chatBackground: () => setStore("appearance", "chatBackground", ""),
      homeBackground: () => setStore("appearance", "homeBackground", ""),
      userAvatar: () => setStore("userProfile", "avatar", ""),
      assistantAvatar: () => setStore("assistantProfile", "avatar", ""),
    }
    createEffect(() => {
      if (!ready() || !mediaReady()) return
      untrack(() => {
        const plan = planMediaMigration({
          legacy: {
            chatBackground: store.appearance?.chatBackground,
            homeBackground: store.appearance?.homeBackground,
            userAvatar: store.userProfile?.avatar,
            assistantAvatar: store.assistantProfile?.avatar,
          },
          media,
        })
        for (const [key, value] of plan.write) setMedia(key, value)
        for (const key of plan.clear) clearLegacy[key]()
      })
    })

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
        chatBackground: withFallback(() => media.chatBackground, defaultMedia.chatBackground),
        setChatBackground(value: string) {
          setMedia("chatBackground", value)
        },
        homeBackground: withFallback(() => media.homeBackground, defaultMedia.homeBackground),
        setHomeBackground(value: string) {
          setMedia("homeBackground", value)
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
        avatar: withFallback(() => media.userAvatar, defaultMedia.userAvatar),
        setAvatar(value: string) {
          setMedia("userAvatar", value)
        },
        displayName: withFallback(() => store.userProfile?.displayName, defaultSettings.userProfile.displayName),
        setDisplayName(value: string) {
          setStore("userProfile", "displayName", value)
        },
      },
      assistantProfile: {
        avatar: withFallback(() => media.assistantAvatar, defaultMedia.assistantAvatar),
        setAvatar(value: string) {
          setMedia("assistantAvatar", value)
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
