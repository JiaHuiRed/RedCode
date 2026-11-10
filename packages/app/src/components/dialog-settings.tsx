import { Suspense, lazy, onCleanup, onMount, type Component } from "solid-js"
import { Dialog } from "@redcode-ai/ui/dialog"
import { Tabs } from "@redcode-ai/ui/tabs"
import { Icon } from "@redcode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createStore } from "solid-js/store"
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
    <Dialog size="x-large" transition>
      <Tabs
        orientation="vertical"
        variant="settings"
        value={tab.value}
        onChange={(value) => setTabStore("value", value)}
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full pt-3">
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
