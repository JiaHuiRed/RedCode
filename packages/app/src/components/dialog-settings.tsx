import {
  Suspense,
  lazy,
  onCleanup,
  onMount,
  createEffect,
  createMemo,
  on,
  For,
  Show,
  Switch,
  Match,
  type Component,
} from "solid-js"
import { Dialog, type DialogSize } from "@redcode-ai/ui/dialog"
import { Icon } from "@redcode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createStore, reconcile } from "solid-js/store"
import { persisted } from "@/utils/persist"
import { SETTINGS_SECTIONS, createSettingsNavigation, settingsTab, type SettingsTab } from "./settings-navigation"

const SettingsGeneral = lazy(() => import("./settings-general").then((m) => ({ default: m.SettingsGeneral })))
const SettingsKeybinds = lazy(() => import("./settings-keybinds").then((m) => ({ default: m.SettingsKeybinds })))
const SettingsProviders = lazy(() => import("./settings-providers").then((m) => ({ default: m.SettingsProviders })))
const SettingsModels = lazy(() => import("./settings-models").then((m) => ({ default: m.SettingsModels })))
const SettingsAgents = lazy(() => import("./settings-agents").then((m) => ({ default: m.SettingsAgents })))
const SettingsPermissions = lazy(() =>
  import("./settings-permissions").then((m) => ({ default: m.SettingsPermissions })),
)
const SettingsMcp = lazy(() => import("./settings-mcp").then((m) => ({ default: m.SettingsMcp })))
const SettingsPersonalization = lazy(() =>
  import("./settings-personalization").then((m) => ({ default: m.SettingsPersonalization })),
)
const SettingsChatCompanion = lazy(() =>
  import("./settings-chat-companion").then((m) => ({ default: m.SettingsChatCompanion })),
)
const SettingsFiles = lazy(() => import("./settings-files").then((m) => ({ default: m.SettingsFiles })))
const SettingsDiagnostics = lazy(() =>
  import("./settings-diagnostics").then((m) => ({ default: m.SettingsDiagnostics })),
)

const groups = ["personal", "app", "code", "data"] as const

// See docs/notes/implemented/feature/2026-11-18-settings-modernization.md for scope and review decisions.
export const DialogSettings: Component<{ initialTab?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const [tab, setTab, , tabReady] = persisted("settings.dialog.tab", createStore({ value: "chat" }))
  const [size, setSize] = persisted("settings.dialog.size", createStore<DialogSize>({}))
  const [ui, setUi] = createStore({ search: "" })
  const navigation = createSettingsNavigation({
    initial: props.initialTab,
    saved: () => tab.value,
    ready: tabReady,
    persist: (value) => setTab("value", value),
  })
  const selected = navigation.value
  const active = createMemo(() => SETTINGS_SECTIONS.find((entry) => entry.id === selected())!)
  const positions = new Map<string, number>()
  let content: HTMLDivElement | undefined
  let searchInput: HTMLInputElement | undefined

  const results = createMemo(() => {
    const query = ui.search.trim().toLocaleLowerCase()
    return SETTINGS_SECTIONS.filter((entry) =>
      `${language.t(entry.key)} ${entry.keywords}`.toLocaleLowerCase().includes(query),
    )
  })

  const select = (value: SettingsTab) => {
    if (content) positions.set(selected(), content.scrollTop)
    navigation.select(value)
    setUi("search", "")
  }

  createEffect(
    on(selected, (value) => {
      if (!content) return
      const pane = content
      const saved = positions.get(value) ?? 0
      pane.scrollTop = saved
      // A lazy page may mount after this effect; observe that mount, not nested scrollers.
      const observer = new MutationObserver(() => {
        pane.scrollTop = saved
        if (pane.scrollHeight >= saved + pane.clientHeight) observer.disconnect()
      })
      observer.observe(pane, { childList: true, subtree: true })
      const expiry = setTimeout(() => observer.disconnect(), 2500)
      onCleanup(() => {
        observer.disconnect()
        clearTimeout(expiry)
      })
    }),
  )

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return
      event.preventDefault()
      searchInput?.focus()
      searchInput?.select()
    }
    content?.closest(".settings-dialog-frame")?.addEventListener("keydown", onKey as EventListener)
    onCleanup(() => content?.closest(".settings-dialog-frame")?.removeEventListener("keydown", onKey as EventListener))
  })

  const navItem = (entry: (typeof SETTINGS_SECTIONS)[number]) => (
    <button
      type="button"
      class="settings-nav-item"
      aria-current={selected() === entry.id ? "page" : undefined}
      onClick={() => select(entry.id)}
    >
      <Icon name={entry.icon} size="small" />
      <span>{language.t(entry.key)}</span>
    </button>
  )

  return (
    <Dialog
      size="x-large"
      transition
      class="settings-dialog-frame"
      title={language.t("settings.title")}
      resizable
      minWidth={320}
      minHeight={360}
      dialogSize={size}
      onResize={(next) => setSize(reconcile(next))}
    >
      <div class="settings-layout" data-searching={!!ui.search.trim()}>
        <aside class="settings-sidebar">
          <div class="settings-search">
            <Icon name="magnifying-glass" size="small" />
            <input
              ref={searchInput}
              type="search"
              value={ui.search}
              onInput={(event) => setUi("search", event.currentTarget.value)}
              aria-label={language.t("settings.search.placeholder")}
              placeholder={language.t("settings.search.placeholder")}
              spellcheck={false}
            />
          </div>
          <nav class="settings-nav-scroll" aria-label={language.t("settings.title")}>
            <Show
              when={!ui.search.trim()}
              fallback={
                <div class="settings-nav-group">
                  <Show
                    when={results().length}
                    fallback={<p class="settings-empty">{language.t("settings.search.noResults")}</p>}
                  >
                    <For each={results()}>{navItem}</For>
                  </Show>
                </div>
              }
            >
              <For each={groups}>
                {(group) => (
                  <div class="settings-nav-group">
                    <div class="settings-nav-group-title">{language.t(`settings.modern.group.${group}`)}</div>
                    <For each={SETTINGS_SECTIONS.filter((entry) => entry.group === group)}>{navItem}</For>
                  </div>
                )}
              </For>
            </Show>
          </nav>
          <footer class="settings-brand">
            <strong>
              Red<span>Space</span>
            </strong>
            <Show when={platform.version}>
              <span>v{platform.version}</span>
            </Show>
          </footer>
        </aside>
        <div class="settings-content">
          <div class="settings-mobile-nav">
            <select
              aria-label={language.t("settings.title")}
              value={selected()}
              onChange={(event) => {
                const next = settingsTab(event.currentTarget.value)
                if (next) select(next)
              }}
            >
              <For each={SETTINGS_SECTIONS}>{(entry) => <option value={entry.id}>{language.t(entry.key)}</option>}</For>
            </select>
          </div>
          <div
            ref={content}
            class="settings-content-scroll"
            role="region"
            aria-label={language.t(active().key)}
            tabIndex={-1}
          >
            <Suspense
              fallback={
                <div class="settings-loading" role="status">
                  {language.t("common.loading")}
                </div>
              }
            >
              <Switch>
                <Match when={selected() === "chat"}>
                  <SettingsChatCompanion />
                </Match>
                <Match when={selected() === "personalization"}>
                  <SettingsPersonalization />
                </Match>
                <Match when={selected() === "general"}>
                  <SettingsGeneral section="general" />
                </Match>
                <Match when={selected() === "appearance"}>
                  <SettingsGeneral section="appearance" />
                </Match>
                <Match when={selected() === "sound"}>
                  <SettingsGeneral section="sound" />
                </Match>
                <Match when={selected() === "devices"}>
                  <SettingsGeneral section="devices" />
                </Match>
                <Match when={selected() === "shortcuts"}>
                  <SettingsKeybinds />
                </Match>
                <Match when={selected() === "providers"}>
                  <SettingsProviders />
                </Match>
                <Match when={selected() === "models"}>
                  <SettingsModels />
                </Match>
                <Match when={selected() === "agents"}>
                  <SettingsAgents />
                </Match>
                <Match when={selected() === "permissions"}>
                  <SettingsPermissions />
                </Match>
                <Match when={selected() === "mcp"}>
                  <SettingsMcp />
                </Match>
                <Match when={selected() === "files"}>
                  <SettingsFiles />
                </Match>
                <Match when={selected() === "diagnostics"}>
                  <SettingsDiagnostics />
                  <SettingsGeneral section="updates" />
                </Match>
              </Switch>
            </Suspense>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
