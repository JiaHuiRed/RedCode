import { createEffect, createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

// Settings navigation is shared by search, deep links and persisted selection.
export const SETTINGS_SECTIONS = [
  {
    id: "chat",
    icon: "speech-bubble",
    group: "personal",
    key: "settings.modern.chat",
    keywords: "chat companion soul identity profile 伙伴 聊天 灵魂 身份 称呼",
  },
  {
    id: "personalization",
    icon: "brain",
    group: "personal",
    key: "settings.modern.codeSoul",
    keywords: "code soul persona default 人格 灵魂 编程 默认",
  },
  {
    id: "general",
    icon: "sliders",
    group: "app",
    key: "settings.tab.general",
    keywords: "general language avatar pet progress 语言 头像 桌宠 进度 昵称",
  },
  {
    id: "appearance",
    icon: "photo",
    group: "app",
    key: "settings.modern.appearance",
    keywords: "theme appearance font wallpaper display zoom 外观 主题 背景 壁纸 字体 字号 缩放",
  },
  {
    id: "sound",
    icon: "volume",
    group: "app",
    key: "settings.modern.sound",
    keywords: "tts voice sound notification MiMo 音效 语音 通知 朗读",
  },
  {
    id: "shortcuts",
    icon: "keyboard",
    group: "app",
    key: "settings.tab.shortcuts",
    keywords: "shortcut keyboard hotkey 快捷键 键位",
  },
  {
    id: "providers",
    icon: "providers",
    group: "code",
    key: "settings.providers.title",
    keywords: "provider api key auth 服务商 供应商 连接 密钥",
  },
  {
    id: "models",
    icon: "models",
    group: "code",
    key: "settings.models.title",
    keywords: "model default visibility 模型 默认 显示 隐藏",
  },
  {
    id: "agents",
    icon: "task",
    group: "code",
    key: "settings.agents.title",
    keywords: "agent subagent build plan shell verification compaction 智能体 子代理 工具 终端 校验 压缩 快照",
  },
  {
    id: "permissions",
    icon: "shield",
    group: "code",
    key: "settings.permissions.title",
    keywords: "permission allow ask deny autoaccept 权限 授权 自动批准",
  },
  {
    id: "mcp",
    icon: "mcp",
    group: "code",
    key: "settings.mcp.title",
    keywords: "mcp server tools environment headers 插件 工具 服务 环境变量",
  },
  {
    id: "devices",
    icon: "window-cursor",
    group: "data",
    key: "settings.modern.devices",
    keywords: "device mobile phone pairing 手机 设备 配对 连接",
  },
  {
    id: "files",
    icon: "folder",
    group: "data",
    key: "settings.modern.files",
    keywords: "files data directory config instructions skills memory import 文件 数据 目录 配置 规则 技能 记忆 导入",
  },
  {
    id: "diagnostics",
    icon: "status",
    group: "data",
    key: "settings.tab.diagnostics",
    keywords: "diagnostics log update version 诊断 日志 更新 版本",
  },
] as const

export type SettingsTab = (typeof SETTINGS_SECTIONS)[number]["id"]
export const settingsTab = (value?: string): SettingsTab | undefined =>
  SETTINGS_SECTIONS.find((entry) => entry.id === value)?.id

export function resolveSettingsTab(input: { explicit?: string; saved?: string }) {
  return settingsTab(input.explicit) ?? settingsTab(input.saved) ?? "chat"
}

export function createSettingsNavigation(input: {
  initial?: string
  saved: Accessor<string | undefined>
  ready: Accessor<boolean>
  persist: (value: SettingsTab) => void
}) {
  const [state, setState] = createStore<{ intent?: SettingsTab }>({ intent: settingsTab(input.initial) })
  const value = createMemo(() => resolveSettingsTab({ explicit: state.intent, saved: input.saved() }))
  createEffect(() => {
    if (input.ready()) input.persist(value())
  })
  return { value, select: (intent: SettingsTab) => setState("intent", intent) }
}
