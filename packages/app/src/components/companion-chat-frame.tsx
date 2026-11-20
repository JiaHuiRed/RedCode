import { Popover } from "@kobalte/core/popover"
import { useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { For, Show, createEffect, createMemo, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { CompanionInfo, Session } from "@redcode-ai/sdk/v2/client"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { Icon } from "@redcode-ai/ui/icon"
import { Mark } from "@redcode-ai/ui/logo"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { companionSessions, newConversationHref } from "@/utils/product-mode"
import { CompanionDreamDiary } from "./companion-dream-diary"
import { SoulAvatar } from "./soul-avatar"
import "./companion-chat-frame.css"

export function useCompanionHistory(owner: () => { id: string; directory: string } | undefined) {
  const sdk = useGlobalSDK()
  return useQuery(() => ({
    queryKey: ["companion", sdk.url, owner()?.id, "sessions"],
    enabled: !!owner(),
    refetchOnMount: true,
    queryFn: async ({ signal }) => {
      const selected = owner()
      if (!selected) return []
      const response = await sdk.client.session.list(
        { directory: selected.directory, roots: true },
        { throwOnError: true, signal },
      )
      return companionSessions(response.data, selected.id)
    },
  }))
}

export function SessionChatFrame(props: { session: Session; children: JSX.Element }) {
  const sdk = useGlobalSDK()
  const profiles = useQuery(() => ({
    queryKey: ["companion", sdk.url, "list"],
    queryFn: async () => (await sdk.client.companion.list({ throwOnError: true })).data,
  }))
  const history = useCompanionHistory(() => {
    const id = props.session.companionID
    return id ? { id, directory: props.session.directory } : undefined
  })
  return (
    <CompanionChatFrame
      profile={profiles.data?.find((p) => p.id === props.session.companionID)}
      session={props.session}
      history={history}
    >
      {props.children}
    </CompanionChatFrame>
  )
}

export function CompanionChatFrame(props: {
  profile?: CompanionInfo
  session?: Session
  history: ReturnType<typeof useCompanionHistory>
  options?: JSX.Element
  children: JSX.Element
}) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [rail, setRail] = persisted(Persist.global("chat.sidebar"), createStore({ collapsed: false }))
  const [ui, setUI] = createStore({ search: false, query: "", submitted: "", drawer: false, menu: false })
  let searchBox: HTMLInputElement | undefined
  const home = () => newConversationHref("chat", undefined, props.profile?.id ?? props.session?.companionID)
  const matchesTitle = (session: Session) =>
    session.title.toLocaleLowerCase().includes(ui.query.trim().toLocaleLowerCase())
  // Filter local titles while typing. Search message history only on explicit request and stop on navigation.
  const contents = useQuery(() => ({
    queryKey: ["companion-history-search", sdk.url, props.profile?.id ?? props.session?.companionID, ui.submitted],
    enabled: !!ui.submitted && !!props.history.data,
    retry: false,
    queryFn: async ({ signal }) => {
      const q = ui.submitted
      const matches: string[] = []
      for (const session of props.history.data ?? []) {
        if (matchesTitle(session)) continue
        let cursor: string | undefined
        do {
          const response = await sdk.client.session.query(
            { directory: session.directory, sessionID: session.id, q, cursor, limit: "1" },
            { signal, throwOnError: true },
          )
          if (response.data.results.length) {
            matches.push(session.id)
            break
          }
          cursor = response.data.nextCursor
        } while (cursor && !signal.aborted)
      }
      return matches
    },
  }))
  const history = createMemo(() => {
    const matches = new Set(ui.submitted ? contents.data : [])
    return (props.history.data ?? []).filter((s) => matchesTitle(s) || matches.has(s.id))
  })
  const day = createMemo(
    () => new Intl.DateTimeFormat(language.locale(), { month: "long", day: "numeric", year: "numeric" }),
  )
  const date = (session: Session) => day().format(session.time.updated ?? session.time.created)
  const closeDrawer = () => setUI("drawer", false)
  const search = () => {
    setUI({ search: true, drawer: window.matchMedia("(max-width: 700px)").matches })
    setRail("collapsed", false)
    queueMicrotask(() => searchBox?.focus())
  }
  const keydown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || document.querySelector('[role="dialog"],dialog[open]')) return
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyN") {
      e.preventDefault()
      void navigate(home())
      closeDrawer()
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyK") {
      e.preventDefault()
      e.stopPropagation()
      search()
    } else if (e.key === "Escape" && (ui.drawer || ui.search)) {
      setUI({ drawer: false, search: false, query: "", submitted: "" })
    }
  }
  onMount(() => {
    window.addEventListener("keydown", keydown, true)
    onCleanup(() => window.removeEventListener("keydown", keydown, true))
  })
  createEffect(() => {
    void props.session?.id
    void props.profile?.id
    setUI({ drawer: false, query: "", submitted: "", search: false, menu: false })
  })
  const settings = async () => {
    setUI("menu", false)
    const { DialogSettings } = await import("@/components/dialog-settings")
    dialog.show(() => <DialogSettings initialTab="chat" />)
  }
  const toggleRail = () => {
    if (window.matchMedia("(max-width: 700px)").matches) setUI("drawer", !ui.drawer)
    else setRail("collapsed", !rail.collapsed)
  }
  return (
    <div class="companion-frame" classList={{ folded: rail.collapsed, "drawer-open": ui.drawer }}>
      <button
        type="button"
        class="companion-scrim"
        aria-label={language.t("command.sidebar.toggle")}
        onClick={closeDrawer}
      />
      <aside class="companion-rail" aria-label={language.t("chat.recent")}>
        <div class="companion-brand">
          <a href={home()}>
            <Mark aria-hidden="true" />
            RedSpace
          </a>
          <button
            type="button"
            class="chat-icon"
            onClick={toggleRail}
            aria-label={language.t("command.sidebar.toggle")}
          >
            <Icon name="layout-left" />
          </button>
        </div>
        <a class="companion-new" href={home()} onClick={closeDrawer}>
          <Icon name="new-session" />
          {language.t("chat.ui.new")}
          <kbd>Alt N</kbd>
        </a>
        <Show
          when={ui.search}
          fallback={
            <button type="button" class="companion-search" onClick={search}>
              <Icon name="magnifying-glass" />
              {language.t("chat.ui.search")}
            </button>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setUI("submitted", ui.query.trim())
            }}
          >
            <input
              ref={searchBox}
              type="search"
              class="companion-filter"
              aria-label={language.t("chat.ui.search")}
              placeholder={language.t("chat.ui.search")}
              value={ui.query}
              onInput={(e) => setUI({ query: e.currentTarget.value, submitted: "" })}
            />
            <Show when={ui.query.trim()}>
              <button type="submit" class="companion-search-body" disabled={contents.isFetching}>
                {language.t(contents.isFetching ? "session.search.searching" : "chat.ui.searchBody")}
              </button>
            </Show>
          </form>
        </Show>
        <nav class="companion-history" aria-label={language.t("chat.recent")}>
          <Show when={ui.submitted && contents.isError}>
            <button type="button" onClick={() => void contents.refetch()}>
              {language.t("common.retry")}
            </button>
          </Show>
          <Show when={props.history.isError}>
            <button type="button" onClick={() => void props.history.refetch()}>
              {language.t("common.retry")}
            </button>
          </Show>
          <For each={history()}>
            {(s, index) => (
              <>
                <Show when={!index() || date(history()[index() - 1]!) !== date(s)}>
                  <p>{date(s)}</p>
                </Show>
                <a
                  href={`/${base64Encode(s.directory)}/session/${s.id}`}
                  aria-current={props.session?.id === s.id ? "page" : undefined}
                  onClick={closeDrawer}
                  title={s.title}
                >
                  {s.title}
                </a>
              </>
            )}
          </For>
          <Show when={!history().length && !props.history.isLoading && !props.history.isError && !contents.isFetching}>
            <p>{language.t(ui.query ? "session.search.empty" : "chat.recent.empty")}</p>
          </Show>
        </nav>
        <Show when={props.profile}>
          {(profile) => (
            <button
              type="button"
              class="companion-profile"
              onClick={() => {
                closeDrawer()
                setUI("menu", true)
              }}
            >
              <SoulAvatar
                id={profile().soulID}
                soul={{ id: profile().soulID, name: profile().name, displayName: profile().name }}
              />
              <span>{profile().name}</span>
              <Icon name="chevron-grabber-vertical" size="small" />
            </button>
          )}
        </Show>
      </aside>
      <main class="companion-stage">
        <header class="companion-bar">
          <button
            type="button"
            class="chat-icon companion-reopen"
            onClick={toggleRail}
            aria-label={language.t("command.sidebar.toggle")}
          >
            <Icon name="layout-left" />
          </button>
          <a href={home()}>Chat</a>
          <span aria-hidden="true">/</span>
          <span class="companion-page-title">{props.session?.title || language.t("chat.ui.new")}</span>
          <Popover open={ui.menu} onOpenChange={(open) => setUI("menu", open)} placement="bottom-end" gutter={6}>
            <Popover.Trigger class="chat-icon companion-more" aria-label={language.t("chat.ui.options")}>
              <Icon name="dot-grid" />
            </Popover.Trigger>
            <Popover.Content class="companion-options">
              {props.options}
              <Show when={props.profile}>
                {(profile) => (
                  <button
                    type="button"
                    onClick={() => {
                      const owner = profile()
                      setUI("menu", false)
                      dialog.show(() => <CompanionDreamDiary profile={owner} />)
                    }}
                  >
                    {language.t("chat.dreams.title")}
                  </button>
                )}
              </Show>
              <button type="button" onClick={() => void settings()}>
                {language.t("chat.native.settings")}
              </button>
            </Popover.Content>
          </Popover>
        </header>
        {props.children}
      </main>
    </div>
  )
}
