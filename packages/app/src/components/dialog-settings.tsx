import { Suspense, lazy, onCleanup, onMount, createEffect, createMemo, createSignal, on, type Component } from "solid-js"
import { For, Show } from "solid-js"
import { Dialog, type DialogSize } from "@redcode-ai/ui/dialog"
import { Tabs } from "@redcode-ai/ui/tabs"
import { TextField } from "@redcode-ai/ui/text-field"
import { Icon } from "@redcode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createStore, reconcile } from "solid-js/store"
import { persisted } from "@/utils/persist"

// 261110 Red 外部审计第 3 项：设置分区按需加载 + 记住上次分区 + 入口可指定分区。
// 此前九个分区静态导入（general 拖 1190 行、providers 拖三个 dialog 进首开
// chunk），且 defaultValue="general" 使每次打开都回到常规页；Kobalte 的非活跃
// Content 本就不挂载，所以运行时渲染成本只在 chunk 体积与首开 eval。
const SettingsGeneral = lazy(() => import("./settings-general").then((m) => ({ default: m.SettingsGeneral })))
const SettingsKeybinds = lazy(() => import("./settings-keybinds").then((m) => ({ default: m.SettingsKeybinds })))
const SettingsProviders = lazy(() => import("./settings-providers").then((m) => ({ default: m.SettingsProviders })))
const SettingsModels = lazy(() => import("./settings-models").then((m) => ({ default: m.SettingsModels })))
const SettingsAgents = lazy(() => import("./settings-agents").then((m) => ({ default: m.SettingsAgents })))
const SettingsPermissions = lazy(() => import("./settings-permissions").then((m) => ({ default: m.SettingsPermissions })))
const SettingsMcp = lazy(() => import("./settings-mcp").then((m) => ({ default: m.SettingsMcp })))
const SettingsPersonalization = lazy(() =>
  import("./settings-personalization").then((m) => ({ default: m.SettingsPersonalization })),
)
const SettingsDiagnostics = lazy(() => import("./settings-diagnostics").then((m) => ({ default: m.SettingsDiagnostics })))

// 261114 Red UX-08 轻量设置索引：跨分区搜索直达（tab + 可选页内锚点）。
// 只索引高频目标；标签取既有 i18n 键，锚点由 settings-general 各分组标题上的
// data-settings-anchor 承载。
const TAB_LABEL_KEYS: Record<string, string> = {
  general: "settings.tab.general",
  shortcuts: "settings.tab.shortcuts",
  personalization: "settings.personalization.title",
  providers: "settings.providers.title",
  models: "settings.models.title",
  agents: "settings.agents.title",
  permissions: "settings.permissions.title",
  mcp: "settings.mcp.title",
  diagnostics: "settings.tab.diagnostics",
}

const SETTINGS_INDEX: { tab: string; anchor?: string; labelKey?: string; keywords: string }[] = [
  { tab: "general", keywords: "general settings 常规 设置" },
  { tab: "shortcuts", keywords: "keybind shortcut 键位 快捷键 hotkey" },
  { tab: "personalization", keywords: "soul 伙伴 人格 persona companion 个性化" },
  { tab: "providers", keywords: "provider api key 服务商 供应商 connect custom" },
  { tab: "models", keywords: "model 模型 provider list" },
  { tab: "agents", keywords: "agent 子代理 任务" },
  { tab: "permissions", keywords: "permission 授权 权限 allowlist" },
  { tab: "mcp", keywords: "mcp server 工具 tool plugin" },
  { tab: "diagnostics", keywords: "diagnostics 诊断 日志 log status" },
  { tab: "general", anchor: "appearance", labelKey: "settings.general.section.appearance", keywords: "theme wallpaper 壁纸 主题 背景 外观 background" },
  { tab: "general", anchor: "display", labelKey: "settings.general.section.display", keywords: "font 字号 字体 显示 display size" },
  { tab: "general", anchor: "notifications", labelKey: "settings.general.section.notifications", keywords: "notification 通知 toast" },
  { tab: "general", anchor: "sounds", labelKey: "settings.general.section.sounds", keywords: "sound 声音 音效 audio" },
  { tab: "general", anchor: "tts", labelKey: "settings.general.section.tts", keywords: "tts 语音 朗读 speech voice" },
  { tab: "general", anchor: "profile", labelKey: "settings.general.section.profile", keywords: "profile 用户资料 头像 avatar user" },
  { tab: "general", anchor: "updates", labelKey: "settings.general.section.updates", keywords: "update 更新 version 升级" },
]

// 首开只拉当前分区的 chunk；空闲时预取其余分区，切换无感。
const SECTION_LOADERS = [
  () => import("./settings-general"),
  () => import("./settings-keybinds"),
  () => import("./settings-providers"),
  () => import("./settings-models"),
  () => import("./settings-agents"),
  () => import("./settings-permissions"),
  () => import("./settings-mcp"),
  () => import("./settings-personalization"),
  () => import("./settings-diagnostics"),
]

export const DialogSettings: Component<{ initialTab?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  // 记住上次所在分区（PersistedWithReady）；initialTab 显式指定时优先。
  // desktop 的 storage 是异步 hydration，晚到的读回可能盖掉 initialTab——
  // 当前零调用方传参，接线时若桌面端出现回跳再补 ready-aware 覆盖。
  const [tabStore, setTabStore] = createStore({ value: props.initialTab ?? "general" })
  const [tab] = persisted("settings.dialog.tab", [tabStore, setTabStore])
  if (props.initialTab) setTabStore("value", props.initialTab)

  // 261114 Red UX-01 设置窗口可调大小：尺寸与最大化持久化，关闭后重开恢复。
  const [sizeStore, setSizeStore] = createStore<DialogSize>({})
  persisted("settings.dialog.size", [sizeStore, setSizeStore])

  // 261114 Red UX-08：搜索直达 + 各分区滚动位置恢复。
  const [search, setSearch] = createSignal("")
  let tabsRef: HTMLDivElement | undefined
  const scrollPositions = new Map<string, number>()

  const results = createMemo(() => {
    const query = search().trim().toLocaleLowerCase()
    if (!query) return []
    return SETTINGS_INDEX.filter((entry) => {
      const label = language.t(entry.labelKey ?? TAB_LABEL_KEYS[entry.tab] ?? "").toLowerCase()
      return `${label} ${entry.keywords}`.toLowerCase().includes(query)
    })
  })

  // lazy chunk 就绪可能晚一拍，锚点滚动重试数帧。
  const scrollToAnchor = (anchor: string) => {
    let tries = 0
    const tick = () => {
      const element = document.querySelector(`[data-settings-anchor="${anchor}"]`)
      if (element) {
        element.scrollIntoView({ block: "start" })
        return
      }
      if (++tries < 20) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  const jump = (entry: (typeof SETTINGS_INDEX)[number]) => {
    setSearch("")
    setTabStore("value", entry.tab)
    if (entry.anchor) scrollToAnchor(entry.anchor)
  }

  const onScrollCapture = (event: Event) => {
    const target = event.target as HTMLElement
    if (!tabsRef || target === tabsRef) return
    if (!target.closest('[role="tabpanel"]')) return
    scrollPositions.set(tab.value, target.scrollTop)
  }

  onMount(() => {
    tabsRef?.addEventListener("scroll", onScrollCapture, true)
    onCleanup(() => tabsRef?.removeEventListener("scroll", onScrollCapture, true))
  })

  // 分区切回时恢复滚动位置：内容按需挂载，rAF 后在已挂载的 tabpanel 里找首个
  // overflow-y-auto 容器（各设置页根节点都带 overflow-y-auto）。
  createEffect(
    on(
      () => tab.value,
      (value) => {
        requestAnimationFrame(() => {
          const panel = tabsRef?.querySelector('[role="tabpanel"]:not([hidden])')
          const scroller = panel?.querySelector<HTMLElement>(".overflow-y-auto") ?? (panel as HTMLElement | null)
          const saved = scrollPositions.get(value)
          if (saved && scroller) scroller.scrollTop = saved
        })
      },
    ),
  )

  onMount(() => {
    const idle = typeof requestIdleCallback === "function" ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 200)
    const handle = idle(() => {
      for (const load of SECTION_LOADERS) void load()
    })
    onCleanup(() => {
      if (typeof handle === "number" && typeof cancelIdleCallback === "function") cancelIdleCallback(handle)
      else clearTimeout(handle as number)
    })
  })

  const sectionFallback = (
    <div class="flex h-full items-center justify-center text-14-regular text-text-weak">
      {language.t("common.loading")}
    </div>
  )

  return (
    <Dialog
      size="x-large"
      transition
      title={language.t("settings.title")}
      resizable
      dialogSize={sizeStore}
      onResize={(next) => setSizeStore(reconcile(next))}
    >
      <Tabs
        ref={tabsRef}
        orientation="vertical"
        variant="settings"
        value={tab.value}
        onChange={(value) => setTabStore("value", value)}
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full pt-3">
              {/* 261114 Red UX-08：跨分区设置搜索，命中直达 tab（或页内锚点）。 */}
              <div class="px-1">
                <TextField
                  value={search()}
                  onChange={(value) => setSearch(value)}
                  placeholder={language.t("settings.search.placeholder")}
                  aria-label={language.t("settings.search.placeholder")}
                />
              </div>
              <Show
                when={search().trim()}
                fallback={
                  <div class="flex flex-col gap-3">
                    <div class="flex flex-col gap-1.5">
                      <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                      <div class="flex flex-col gap-1.5 w-full">
                        <Tabs.Trigger value="general">
                          <Icon name="sliders" />
                          {language.t("settings.tab.general")}
                        </Tabs.Trigger>
                        <Tabs.Trigger value="shortcuts">
                          <Icon name="keyboard" />
                          {language.t("settings.tab.shortcuts")}
                        </Tabs.Trigger>
                        <Tabs.Trigger value="personalization">
                          <Icon name="brain" />
                          {language.t("settings.personalization.title")}
                        </Tabs.Trigger>
                      </div>
                    </div>

                    <div class="flex flex-col gap-1.5">
                      <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                      <div class="flex flex-col gap-1.5 w-full">
                        <Tabs.Trigger value="providers">
                          <Icon name="providers" />
                          {language.t("settings.providers.title")}
                        </Tabs.Trigger>
                        <Tabs.Trigger value="models">
                          <Icon name="models" />
                          {language.t("settings.models.title")}
                        </Tabs.Trigger>
                        <Tabs.Trigger value="agents">
                          <Icon name="task" />
                          {language.t("settings.agents.title")}
                        </Tabs.Trigger>
                        <Tabs.Trigger value="permissions">
                          <Icon name="checklist" />
                          {language.t("settings.permissions.title")}
                        </Tabs.Trigger>
                        <Tabs.Trigger value="mcp">
                          <Icon name="link" />
                          {language.t("settings.mcp.title")}
                        </Tabs.Trigger>
                      </div>
                    </div>

                    <div class="flex flex-col gap-1.5">
                      <Tabs.SectionTitle>{language.t("settings.section.diagnostics")}</Tabs.SectionTitle>
                      <div class="flex flex-col gap-1.5 w-full">
                        <Tabs.Trigger value="diagnostics">
                          <Icon name="status" />
                          {language.t("settings.tab.diagnostics")}
                        </Tabs.Trigger>
                      </div>
                    </div>
                  </div>
                }
              >
                <div class="flex flex-col gap-1 px-1">
                  <Show when={results().length === 0}>
                    <p class="py-2 text-12-regular text-text-weak">{language.t("settings.search.noResults")}</p>
                  </Show>
                  <For each={results()}>
                    {(entry) => (
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-14-medium text-text-base transition-colors hover:bg-surface-raised-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
                        onClick={() => jump(entry)}
                      >
                        <Icon name="magnifying-glass" />
                        <span class="min-w-0 truncate">{language.t(entry.labelKey ?? TAB_LABEL_KEYS[entry.tab])}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <Suspense fallback={sectionFallback}>
            <SettingsGeneral />
          </Suspense>
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <Suspense fallback={sectionFallback}>
            <SettingsKeybinds />
          </Suspense>
        </Tabs.Content>
        <Tabs.Content value="personalization" class="no-scrollbar">
          <Suspense fallback={sectionFallback}>
            <SettingsPersonalization />
          </Suspense>
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <Suspense fallback={sectionFallback}>
            <SettingsProviders />
          </Suspense>
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <Suspense fallback={sectionFallback}>
            <SettingsModels />
          </Suspense>
        </Tabs.Content>
        <Tabs.Content value="agents" class="no-scrollbar">
          <Suspense fallback={sectionFallback}>
            <SettingsAgents />
          </Suspense>
        </Tabs.Content>
        <Tabs.Content value="permissions" class="no-scrollbar">
          <Suspense fallback={sectionFallback}>
            <SettingsPermissions />
          </Suspense>
        </Tabs.Content>
        <Tabs.Content value="mcp" class="no-scrollbar">
          <Suspense fallback={sectionFallback}>
            <SettingsMcp />
          </Suspense>
        </Tabs.Content>
        <Tabs.Content value="diagnostics" class="no-scrollbar">
          <Suspense fallback={sectionFallback}>
            <SettingsDiagnostics />
          </Suspense>
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
