import { createEffect, createMemo, For, mapArray, Match, on, Show, startTransition, Switch, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLocation, useMatch, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@redcode-ai/ui/icon-button"
import { Icon } from "@redcode-ai/ui/icon"
import { Button } from "@redcode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@redcode-ai/ui/tooltip"
import { useTheme } from "@redcode-ai/ui/theme/context"
import { IconButtonV2 } from "@redcode-ai/ui/v2/components/icon-button-v2.jsx"
import { Icon as IconV2 } from "@redcode-ai/ui/v2/components/icon.jsx"

import { getAvatarColors, useLayout, type LocalProject } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { WindowsAppMenu } from "./windows-app-menu"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { useServerSync } from "@/context/server-sync"
import { decodeDirectory } from "@/pages/directory-layout"
import { setActiveMcpDirectory } from "@/context/global-sync/child-store"
import { iife } from "@redcode-ai/core/util/iife"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { Avatar as AvatarV2 } from "@redcode-ai/ui/v2/components/avatar-v2.jsx"
import { displayName, getProjectAvatarSource, projectForSession } from "@/pages/layout/helpers"
import { makeEventListener } from "@solid-primitives/event-listener"
import { StatusPopover } from "./status-popover"
import { SDKProvider } from "@/context/sdk"

type TauriDesktopWindow = {
  startDragging?: () => Promise<void>
  toggleMaximize?: () => Promise<void>
}

type TauriThemeWindow = {
  setTheme?: (theme?: "light" | "dark" | null) => Promise<void>
}

type TauriApi = {
  window?: {
    getCurrentWindow?: () => TauriDesktopWindow
  }
  webviewWindow?: {
    getCurrentWebviewWindow?: () => TauriThemeWindow
  }
}

const tauriApi = () => (window as unknown as { __TAURI__?: TauriApi }).__TAURI__
const currentDesktopWindow = () => tauriApi()?.window?.getCurrentWindow?.()
const currentThemeWindow = () => tauriApi()?.webviewWindow?.getCurrentWebviewWindow?.()
const legacyTitlebarHeight = 40
const v2TitlebarHeight = 44
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.
const USE_V2_TITLEBAR = true

const makeSessionHref = (b64Dir: string, sessionId: string) => `/${b64Dir}/session/${sessionId}`

export type TitlebarUpdate = {
  version: () => string | undefined
  installing: () => boolean
  install: () => void
}

export function Titlebar(props: { update?: TitlebarUpdate }) {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const theme = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const electronWindows = createMemo(() => windows() && !tauriApi())
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const web = createMemo(() => platform.platform === "web")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const counterZoom = () => (windows() && titlebarZoom() < 1 ? 1 / titlebarZoom() : 1)
  const minHeight = () => {
    const height = USE_V2_TITLEBAR ? v2TitlebarHeight : legacyTitlebarHeight
    if (mac()) return `${height / zoom()}px`
    if (windows()) return `${height / Math.min(titlebarZoom(), 1)}px`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)
  const hasProjects = createMemo(() => layout.projects.list().length > 0)
  const nav = createMemo(() => true)

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  const getWin = () => {
    if (platform.platform !== "desktop") return
    return currentDesktopWindow()
  }

  createEffect(() => {
    if (platform.platform !== "desktop") return

    const scheme = theme.colorScheme()
    const win = currentThemeWindow()
    if (!win?.setTheme) return

    void win.setTheme(scheme === "system" ? null : theme.mode()).catch(() => undefined)
  })

  const interactive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false

    const selector =
      "button, a, input, textarea, select, option, [role='button'], [role='menuitem'], [contenteditable='true'], [contenteditable='']"

    return !!target.closest(selector)
  }

  const drag = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (e.buttons !== 1) return
    if (interactive(e.target)) return

    const win = getWin()
    if (!win?.startDragging) return

    e.preventDefault()
    void win.startDragging().catch(() => undefined)
  }

  const maximize = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (interactive(e.target)) return
    if (e.target instanceof Element && e.target.closest("[data-tauri-decorum-tb]")) return

    const win = getWin()
    if (!win?.toggleMaximize) return

    e.preventDefault()
    void win.toggleMaximize().catch(() => undefined)
  }

  return (
    <header
      classList={{
        "shrink-0 relative z-[1] overflow-hidden flex flex-row": true,
        "h-11 bg-v2-background-bg-deep": USE_V2_TITLEBAR,
        "h-10 bg-background-base": !USE_V2_TITLEBAR,
        "border-b border-border-weaker-base": true,
      }}
      data-frost-surface="titlebar"
      style={{
        "min-height": minHeight(),
        "padding-left": mac() ? `${84 / zoom()}px` : 0,
        width: electronWindows() ? `env(titlebar-area-width, 100vw)` : undefined,
        "max-width": electronWindows() ? `env(titlebar-area-width, 100vw)` : undefined,
        "align-self": electronWindows() ? "flex-start" : undefined,
      }}
      data-tauri-drag-region
      onMouseDown={drag}
      onDblClick={maximize}
    >
      <V2TitlebarContent update={props.update} />
    </header>
  )
}

function V2TitlebarContent(props: { update?: TitlebarUpdate }) {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const params = useParams()
  const location = useLocation()

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const electronWindows = createMemo(() => windows() && !tauriApi())
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")

  const creating = createMemo(() => {
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

  const globalSync = useServerSync()
  const navigate = useNavigate()
  const homeMatch = useMatch(() => "/")

  const newSessionHref = () => {
    if (params.dir) return `/${params.dir}/session`
    const project = layout.projects.list()[0]
    if (!project) return "/"
    return `/${base64Encode(project.worktree)}/session`
  }

  type Tab = { dir: string; sessionId: string; href: string }

  const [tabsStore, tabsStoreActions] = iife(() => {
    const [store, setStore] = createStore<Tab[]>(
      iife(() => {
        if (!params.dir || !params.id) return []
        return [
          {
            dir: decodeDirectory(params.dir) ?? "",
            sessionId: params.id,
            href: makeSessionHref(params.dir, params.id),
          },
        ]
      }),
    )

    const actions = {
      addTab: (tab: Tab) => {
        setStore(
          produce((tabs) => {
            if (tabs.some((t) => t.href === tab.href)) return
            tabs.push(tab)
          }),
        )
      },
      removeTab: (href: string) => {
        startTransition(() => {
          setStore(
            produce((tabs) => {
              const index = tabs.findIndex((t) => t.href === href)
              if (index === -1) return
              tabs.splice(index, 1)
              const nextTab = tabs[index] ?? tabs[tabs.length - 1]
              if (nextTab) navigate(nextTab.href)
              else navigate("/")
            }),
          )
        })
      },
    }

    return [store, actions]
  })

  createEffect(() => {
    if (!(params.dir && params.id)) return
    tabsStoreActions.addTab({
      dir: decodeDirectory(params.dir) ?? "",
      sessionId: params.id,
      href: makeSessionHref(params.dir, params.id),
    })
  })

  const projects = createMemo(() => layout.projects.list())
  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )

  const currentSessionTab = () => {
    if (!params.dir || !params.id) return
    const href = makeSessionHref(params.dir, params.id)
    return tabsStore.find((tab) => tab.href === href)
  }

  // 260609 Red 当前路由所在项目目录（params.dir 是 base64，解码成真实路径）。
  //   新会话页(无 params.id)既无 currentSessionTab 也未必在 tabsStore，必须直接认 params.dir，
  //   否则 statusDir/activeMcpDir 都会兜底到 projects()[0]——多项目时那是"别的项目"，
  //   导致 popover 读 A 项目 store、却 enable 了 B 项目的 MCP query，永远对不上→"未配置 MCPs"。
  const routeDir = createMemo(() => (params.dir ? decodeDirectory(params.dir) : undefined))

  // 260608 Yuqi 首页也显示 MCP 状态：当前路由项目 → 当前会话 dir → 第一个 tabs → 第一个项目的目录；都不存在则隐藏
  const statusDir = createMemo(() => {
    const fromRoute = routeDir()
    if (fromRoute) return fromRoute
    const fromSession = currentSessionTab()?.dir
    if (fromSession) return fromSession
    const fromTabs = tabsStore[0]?.dir
    if (fromTabs) return fromTabs
    return projects()[0]?.worktree
  })

  // 260609 Red 只在真有进入的项目(routeDir/session/tab)时激活 MCP；首页(无 params.dir)一律不连。
  //   恢复 0.4.6 延迟连接的"首页不 spawn"语义——首页 routeDir 为空且不取 projects()[0]，落空不连；
  //   进项目即用 routeDir 与 statusDir 对齐到同一个 store，popover 才能显示真实 MCP 状态。
  const activeMcpDir = createMemo(() => routeDir() ?? currentSessionTab()?.dir ?? tabsStore[0]?.dir)
  createEffect(on(activeMcpDir, (dir) => {
    if (dir) setActiveMcpDirectory(dir)
  }))

  // 260610 Red 方案 A：标题栏状态圆点点击 → 打开右侧面板的 status 标签页（仅在有会话时）
  const openStatusTab = () => {
    if (!params.dir || !params.id) return
    const key = `${params.dir}/${params.id}`
    layout.view(key).reviewPanel.open()
    void layout.tabs(key).open("status")
    layout.tabs(key).setActive("status")
  }

  const closeCurrentSessionTab = () => {
    const tab = currentSessionTab()
    if (!tab) return false
    tabsStoreActions.removeTab(tab.href)
    return true
  }

  const closeNewSessionTab = () => {
    if (!(params.dir && !params.id)) return false
    const last = tabsStore[tabsStore.length - 1]
    if (last) navigate(last.href)
    else navigate("/")
    return true
  }

  makeEventListener(
    document,
    "keydown",
    (event) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "w") return
      if (!(closeCurrentSessionTab() || closeNewSessionTab())) return
      event.preventDefault()
      event.stopPropagation()
    },
    { capture: true },
  )

  command.register(() => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft`,
      hidden: true,
      onSelect: () => {
        let index = tabsStore.findIndex((tab) => tab.href === currentSessionTab()?.href)
        if (index === -1) return
        index -= 1
        if (index === -1) index = tabsStore.length - 1
        const next = tabsStore[index]
        if (next) navigate(next.href)
      },
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight`,
      hidden: true,
      onSelect: () => {
        let index = tabsStore.findIndex((tab) => tab.href === currentSessionTab()?.href)
        if (index === -1) return
        index += 1
        if (index === tabsStore.length) index = 0
        const next = tabsStore[index]
        if (next) navigate(next.href)
      },
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `tab.${i + 1}`,
      category: "tab",
      title: "",
      keybind: `mod+${i + 1}`,
      disabled: layout.projects.list().length <= i,
      hidden: true,
      onSelect: () => {
        const tab = tabsStore[i]
        if (tab) navigate(tab.href)
      },
    })),
  ])

  const tabsEnriched = iife(() => {
    const base = mapArray(
      () => tabsStore,
      (tab) => {
        // 260707 Red createDirSyncContext 内部走 child()（bootstrap:true + pinForOwner），
        //   titlebar 对每个恢复的 tab 都建一份——每个 tab 目录都被强制整套 bootstrap 且
        //   永久 pin 住（titlebar 常驻不销毁），是"打开即多目录内存/进程风暴"的真正源头之一。
        //   这里只是要显示 title/status，peek 只读 store 即可，不需要话务/diff/todo 全套同步。
        const [store] = globalSync.peek(tab.dir, { bootstrap: false })
        const session = store.session.find((s) => s.id === tab.sessionId)
        if (!session) return null
        return {
          ...tab,
          info: session,
          status: store.session_status[tab.sessionId]?.type,
        }
      },
    )
    return () => base().flatMap((s) => (s ? [s] : []))
  })

  return (
    <div
      class="h-full flex-1 flex flex-row items-center gap-1.5 pr-3 py-2"
      classList={{
        "pl-2": mac(),
        "pl-4": !mac(),
      }}
    >
      <Show when={windows() || linux()}>
        <WindowsAppMenu command={command} platform={platform} variant="v2" />
      </Show>
      <IconButtonV2
        variant="ghost-muted"
        size="large"
        as="a"
        href="/"
        class="!w-9"
        icon={<IconV2 name="grid-plus" />}
        state={!!homeMatch() ? "pressed" : undefined}
      />
      <div class="flex min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden">
        <div class="flex min-w-0 flex-row items-center gap-1.5 overflow-hidden">
          <For each={tabsEnriched()}>
            {(tab, i) => (
              <>
                {i() !== 0 && (
                  <div class="w-[1.5px] h-3 shrink-0 rounded-full bg-[var(--v2-background-bg-layer-02)]" />
                )}
                <TabNavItem
                  href={tab.href}
                  title={tab.info.title}
                  status={tab.status}
                  project={projectForSession(tab.info, projects(), projectByID())}
                  directory={tab.dir}
                  onClose={() => tabsStoreActions.removeTab(tab.href)}
                  hideClose={tabsEnriched().length < 2}
                />
              </>
            )}
          </For>
        </div>
        <Show
          when={creating() && params.dir}
          fallback={
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="large"
              class="shrink-0"
              icon={<IconV2 name="plus" />}
              as="a"
              href={newSessionHref()}
              aria-label={language.t("command.session.new")}
            />
          }
        >
          <NewSessionTabItem
            href={`/${params.dir}/session`}
            title={language.t("command.session.new")}
            onClose={() => navigate(tabsEnriched().at(-1)?.href ?? "/")}
          />
        </Show>
        <div class="min-w-0 flex-1" />
      </div>
      <Show when={statusDir()} keyed>
        {(dir) => (
          <SDKProvider directory={dir}>
            <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
              <StatusPopover openInPanel={params.dir && params.id ? openStatusTab : undefined} />
            </Tooltip>
          </SDKProvider>
        )}
      </Show>
      <TitlebarUpdatePill update={props.update} />
      <Show when={windows() && !electronWindows()}>
        <div data-tauri-decorum-tb class="flex flex-row" />
      </Show>
    </div>
  )
}

function TitlebarUpdatePill(props: { update?: TitlebarUpdate }) {
  const language = useLanguage()
  const version = () => props.update?.version()

  return (
    <Show when={version() !== undefined}>
      <button
        type="button"
        class="h-5 shrink-0 rounded-[27px] bg-[var(--v2-background-bg-accent)] px-2.5 text-[11px] font-[530] leading-[1.1] tracking-[-0.04px] text-[var(--v2-text-text-contrast)] disabled:opacity-60"
        onClick={() => props.update?.install()}
        disabled={props.update?.installing()}
        aria-label={language.t("toast.update.action.installRestart")}
        title={version() ? `Update ${version()}` : undefined}
      >
        Update
      </button>
    </Show>
  )
}

function TabNavItem(props: {
  href: string
  title: string
  status?: "idle" | "busy" | "retry"
  project?: LocalProject
  directory: string
  hideClose?: boolean
  onClose: () => void
}) {
  const match = useMatch(() => props.href)
  const isActive = () => !!match()
  return (
    <div
      class="group relative flex h-7 min-w-24 max-w-60 flex-row items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[6px] bg-[var(--tab-bg)] pl-1.5 [--tab-bg:var(--v2-background-bg-deep)] hover:[--tab-bg:var(--v2-background-bg-layer-02)] data-[active='true']:[--tab-bg:var(--v2-background-bg-layer-02)]"
      data-active={isActive()}
    >
      <a
        href={props.href}
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base"
      >
        <ProjectTabAvatar project={props.project} directory={props.directory} />
        <span class="flex items-center gap-1.5 min-w-0">
          <Show when={props.status === "busy"}>
            <div class="size-1.5 shrink-0 rounded-full bg-surface-warning-strong animate-pulse" />
          </Show>
          <Show when={props.status === "retry"}>
            <div class="size-1.5 shrink-0 rounded-full bg-surface-critical-strong" />
          </Show>
          <span class="truncate">{props.title}</span>
        </span>
      </a>

      <div class="absolute right-0 inset-y-0 flex flex-row items-center pr-1 py-1 w-8 pl-2">
        <div
          class="absolute inset-0 bg-(image:--inactive-bg) group-hover:bg-(image:--active-bg) group-data-[active=true]:bg-(image:--active-bg)"
          style={{
            "--inactive-bg": "linear-gradient(to right, transparent 0%, var(--tab-bg) 80%)",
            "--active-bg": "linear-gradient(90deg, transparent 0%, var(--tab-bg) 25%)",
          }}
        />
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          class="opacity-0 group-hover:opacity-100 group-data-[active='true']:opacity-100"
          onClick={props.onClose}
          icon={<IconV2 name="xmark-small" />}
        />
      </div>
    </div>
  )
}

function ProjectTabAvatar(props: { project?: LocalProject; directory: string }) {
  return (
    <AvatarV2
      fallback={displayName(props.project ?? { worktree: props.directory })}
      src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
      kind="org"
      size="small"
      {...getAvatarColors(props.project?.icon?.color)}
      class="size-4 rounded"
    />
  )
}

function NewSessionTabItem(props: { href: string; title: string; onClose: () => void }) {
  return (
    <div class="group relative flex h-7 max-w-60 flex-row items-center gap-1.5 overflow-hidden rounded-[6px] bg-[var(--v2-overlay-simple-overlay-pressed)] pl-1.5 pr-8 whitespace-nowrap focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--v2-border-border-focus)]">
      <a
        href={props.href}
        aria-current="page"
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden text-[13px] font-medium leading-none text-[var(--v2-text-text-base)]"
      >
        <span class="flex size-4 shrink-0 rotate-90 items-center justify-center">
          <IconV2 name="edit" />
        </span>
        <span class="truncate">{props.title}</span>
      </a>
      <div class="absolute right-0 inset-y-0 flex w-7 items-center justify-center">
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.onClose()
          }}
          icon={<IconV2 name="xmark-small" />}
          aria-label="Close tab"
        />
      </div>
    </div>
  )
}

function ChannelIndicator() {
  const platform = usePlatform()
  return (
    <Show when={platform.version}>
      {(version) => (
        <span class="text-[11px] text-v2-text-text-muted shrink-0 select-none">v{version()}</span>
      )}
    </Show>
  )
}
