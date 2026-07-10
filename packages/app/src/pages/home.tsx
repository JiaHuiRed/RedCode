import type { Session } from "@redcode-ai/sdk/v2/client"
import { createMemo, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { Spinner } from "@redcode-ai/ui/spinner"
import { ContextMenu } from "@redcode-ai/ui/context-menu"
import { Avatar as AvatarV2 } from "@redcode-ai/ui/v2/components/avatar-v2.jsx"
import { ButtonV2 } from "@redcode-ai/ui/v2/components/button-v2.jsx"
import { Icon as IconV2 } from "@redcode-ai/ui/v2/components/icon.jsx"
import { IconButtonV2 } from "@redcode-ai/ui/v2/components/icon-button-v2.jsx"
import { useGlobalSDK } from "@/context/global-sdk"
import { getAvatarColors, useLayout, type LocalProject } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { displayName, getProjectAvatarSource, projectForSession, sortedRootSessions } from "@/pages/layout/helpers"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { messageAgentColor } from "@/utils/agent"
import { sessionPermissionRequest } from "@/pages/session/composer/session-request-tree"
import { HomeKanban } from "@/pages/home-kanban"
import { HomeStatsPanel } from "@/pages/home-stats"

// 260710 Red 上游从 15 提到 64，修复"只显示 5 个会话"
const HOME_SESSION_LIMIT = 64
const HOME_ROW =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] border-0 bg-transparent text-left [font-weight:530] text-v2-text-text-muted transition-colors duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW} h-8 gap-1.5 px-2 [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap`
const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"

type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

export default function Home() {
  return <HomeDesign />
}

function HomeDesign() {
  const sync = useServerSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  // 260616 Red 默认进看板视图（工作中/需关注/空闲），更直观；可切回列表
  const [state, setState] = createStore({ search: "", project: undefined as string | undefined, view: "kanban" as "list" | "kanban" })
  let searchInputRef: HTMLInputElement | undefined

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        searchInputRef?.focus()
        searchInputRef?.select()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  const projects = createMemo(() => layout.projects.list())
  const selectedProject = createMemo(
    () => projects().find((project) => project.worktree === state.project) ?? projects()[0],
  )
  const projectDirectories = createMemo(() => {
    const project = selectedProject()
    if (!project) return []
    return [project.worktree, ...(project.sandboxes ?? [])]
  })
  const search = createMemo(() => state.search.trim())
  // 260707 Red loadSessions() 对每个目录都是真实 session.list HTTP 请求——服务端
  //   instance-context 中间件对任何带 directory 的路由都会触发该目录整套 InstanceStore.load()
  //   (MCP/LSP/watcher 全起)，client 端的 {bootstrap:false} 只影响本地是否连 query，拦不住这个。
  //   之前对 projectDirectories()（含全部 sandboxes/worktree）一次性 Promise.all 全部 loadSessions，
  //   等于选中项目有几个 sandbox 就同时拉起几套完整 MCP/LSP 进程树——这是"打开即多目录内存/
  //   进程风暴"里独立于 enrich()/titlebar 之外的第三个真正源头。首页只需要主 worktree 的
  //   session 保证可见；sandbox 的 session 只在真被用户展开/进入时才应该真正 bootstrap，
  //   这里改为只主动加载主 worktree，sandbox 一律 peek 只读缓存，不强制拉起。
  const sessionLoad = useQuery(() => ({
    queryKey: ["home", "sessions", selectedProject()?.worktree] as const,
    queryFn: async () => {
      const project = selectedProject()
      if (project) await sync.project.loadSessions(project.worktree)
      return null
    },
  }))

  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const records = createMemo(() =>
    [
      ...new Map(
        projectDirectories()
          .flatMap((directory) => sortedRootSessions(sync.child(directory, { bootstrap: false })[0], Date.now()))
          .map((session) => [`${pathKey(session.directory)}:${session.id}`, session] as const),
      ).values(),
    ]
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .flatMap((session) => {
        const project = projectForSession(session, projects(), projectByID())
        if (!project) return []
        return {
          session,
          project,
          projectName: displayName(project),
        }
      })
      .filter((record) => {
        const value = search().toLowerCase()
        if (!value) return true
        return `${record.session.title} ${record.projectName}`.toLowerCase().includes(value)
      })
      .slice(0, HOME_SESSION_LIMIT),
  )
  const groups = createMemo(() => groupSessions(records(), language))
  // 260701 Red 首页左下角看板用：跟 records() 不一样，不做 15 条截断、不排除子 session
  // （子 agent worktree session 也有独立 cost/tokens，不算进去总花费会偏低）。
  const statsSessions = createMemo(() =>
    projectDirectories().flatMap((directory) => {
      const store = sync.child(directory, { bootstrap: false })[0]
      return (store.session ?? []).filter(
        (session) => pathKey(session.directory) === pathKey(directory) && !session.time?.archived,
      )
    }),
  )

  function selectProject(directory: string) {
    if (!projects().some((project) => project.worktree === directory)) return
    setState("project", directory)
  }

  function addProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    setState("project", directory)
  }

  function openNewSession() {
    const project = selectedProject()
    if (!project) {
      void chooseProject()
      return
    }
    layout.projects.open(project.worktree)
    server.projects.touch(project.worktree)
    navigate(`/${base64Encode(project.worktree)}/session`)
  }

  function openSession(session: Session) {
    const project = projectForSession(session, projects(), projectByID())
    layout.projects.open(project?.worktree ?? session.directory)
    server.projects.touch(project?.worktree ?? session.directory)
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        result.forEach(addProject)
        if (result[0]) setState("project", result[0])
        return
      }
      if (result) addProject(result)
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
      return
    }

    dialog.show(
      () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
      () => resolve(null),
    )
  }

  function openSettings() {
    void import("@/components/dialog-settings").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }

  async function removeProject(project: LocalProject) {
    if (project.id && project.id !== "global") {
      await globalSDK.client.project.remove({ projectID: project.id })
    }
    layout.projects.close(project.worktree)
    if (state.project === project.worktree) setState("project", undefined)
  }

  // 260710 Red 归档会话：标记 archived 时间戳，isRootVisibleSession 自动过滤
  async function archiveSession(session: Session) {
    await globalSDK.client.session.update({ sessionID: session.id, time: { archived: Date.now() } })
  }

  return (
    <div class="grid w-full h-full gap-x-6 pl-2 pr-6 pb-2 lg:grid-cols-[220px_minmax(0,1fr)] grid-rows-[1fr_auto]">
      <HomeProjectColumn
        projects={projects()}
        selected={selectedProject()?.worktree}
        selectProject={selectProject}
        chooseProject={() => void chooseProject()}
        openSettings={openSettings}
        removeProject={(project) => void removeProject(project)}
        language={language}
        statsSessions={statsSessions()}
      />

      <section
        class="min-w-0 flex-1 flex flex-col overflow-y-hidden pt-12"
        aria-label={language.t("sidebar.project.recentSessions")}
      >
        {/* 260615 Red 搜索栏 + 列表/看板视图切换 */}
        <div class="flex items-center gap-2 pr-2">
          <HomeSessionSearch
            ref={(el) => (searchInputRef = el)}
            value={state.search}
            placeholder={language.t("home.sessions.search.placeholder")}
            onInput={(value) => setState("search", value)}
          />
          <Show when={state.view === "kanban"}>
            <IconButtonV2
              data-action="home-new-session-kanban"
              variant="ghost-muted"
              size="large"
              icon={<IconV2 name="plus" />}
              onClick={openNewSession}
              aria-label={language.t("command.session.new")}
              class="size-7"
            />
          </Show>
          <div class="flex shrink-0 gap-0.5 rounded-[6px] bg-v2-background-bg-deep p-0.5">
            <IconButtonV2
              data-action="home-view-list"
              variant={state.view === "list" ? "contrast" : "ghost-muted"}
              size="large"
              icon={<IconV2 name="menu" size="small" />}
              onClick={() => setState("view", "list")}
              aria-label={language.t("home.view.list")}
              aria-pressed={state.view === "list"}
              class="size-7"
            />
            <IconButtonV2
              data-action="home-view-kanban"
              variant={state.view === "kanban" ? "contrast" : "ghost-muted"}
              size="large"
              icon={<IconV2 name="grid-plus" size="small" />}
              onClick={() => setState("view", "kanban")}
              aria-label={language.t("home.view.kanban")}
              aria-pressed={state.view === "kanban"}
              class="size-7"
            />
          </div>
        </div>
        <div class="mt-3 overflow-auto flex-1">
          <Show when={!sessionLoad.isLoading} fallback={<HomeSessionSkeleton label={language.t("common.loading")} />}>
            <Show
              when={records().length > 0}
              fallback={
                <div class="flex min-w-0 flex-col items-center gap-4 py-12">
                  <div class="flex size-12 items-center justify-center rounded-full bg-v2-background-bg-deep">
                    <IconV2 name="edit" size="large" class="text-v2-text-text-muted" />
                  </div>
                  <div class="flex flex-col items-center gap-1 text-center">
                    <div class="text-14-normal font-medium text-v2-text-text-base">{language.t("home.sessions.empty")}</div>
                    <div class="text-12-regular text-v2-text-text-muted">{language.t("command.session.new")}</div>
                  </div>
                  <ButtonV2
                    data-action="home-new-session-empty"
                    variant="contrast"
                    size="normal"
                    icon="edit"
                    class="mt-2"
                    onClick={openNewSession}
                  >
                    {language.t("command.session.new")}
                  </ButtonV2>
                </div>
              }
            >
              <Switch>
                <Match when={state.view === "kanban"}>
                  <HomeKanban records={records()} openSession={openSession} onArchive={archiveSession} />
                </Match>
                <Match when={state.view === "list"}>
                  <div class="pt-3 flex flex-col gap-6">
                    <For each={groups()}>
                      {(group, index) => (
                        <div class="flex min-w-0 flex-col gap-4">
                          <HomeSessionGroupHeader
                            title={group.title}
                            onNewSession={index() === 0 ? openNewSession : undefined}
                          />
                          <div class="flex min-w-0 flex-col gap-px">
                            <For each={group.sessions}>
                              {(record) => <HomeSessionRow record={record} openSession={openSession} onArchive={archiveSession} />}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Match>
              </Switch>
            </Show>
          </Show>
        </div>
      </section>
      {/* 260709 Red 首页底部快捷键提示条 */}
      <HomeShortcutBar />
    </div>
  )
}

// 260709 Red 首页底部快捷键提示条：展示常用快捷键，帮用户发现功能
function HomeShortcutBar() {
  const language = useLanguage()
  const isMac = navigator.platform.includes("Mac")
  const mod = isMac ? "⌘" : "Ctrl"
  const shortcuts = [
    { keys: `${mod}+K`, label: language.t("home.shortcuts.search") },
    { keys: `${mod}+N`, label: language.t("home.shortcuts.newSession") },
    { keys: `Alt+↑↓`, label: language.t("home.shortcuts.switchSession") },
    { keys: `${mod}+\\`, label: language.t("home.shortcuts.fileTree") },
    { keys: `${mod}+,`, label: language.t("home.shortcuts.settings") },
    { keys: `${mod}+P`, label: language.t("home.shortcuts.commandPalette") },
  ]
  return (
    <div class="col-span-full flex items-center justify-center gap-6 px-4 py-3 text-[11px] text-v2-text-text-muted [font-weight:440]">
      <For each={shortcuts}>
        {(item) => (
          <span class="flex items-center gap-1.5">
            <kbd class="inline-flex items-center rounded border border-v2-border-border-strong px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
              {item.keys}
            </kbd>
            <span>{item.label}</span>
          </span>
        )}
      </For>
    </div>
  )
}

function HomeProjectColumn(props: {
  projects: LocalProject[]
  selected?: string
  selectProject: (directory: string) => void
  chooseProject: () => void
  openSettings: () => void
  removeProject: (project: LocalProject) => void
  language: ReturnType<typeof useLanguage>
  statsSessions: Session[]
}) {
  const platform = usePlatform()
  return (
    <aside
      class="flex min-w-0 flex-col lg:pt-[52px] lg:border-r lg:border-v2-border-border-base lg:pr-6"
      aria-label={props.language.t("home.projects")}
    >
      <div class="flex h-7 min-w-0 items-center justify-between pl-2">
        <div class={HOME_SECTION_LABEL}>{props.language.t("home.projects")}</div>
        <IconButtonV2
          data-action="home-add-project"
          variant="ghost-muted"
          size="large"
          class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
          icon={<IconV2 name="folder-add-left" />}
          onClick={props.chooseProject}
          aria-label={props.language.t("home.project.add")}
        />
      </div>
      {/* 260709 Red 项目列表占据剩余空间，flex-1 + min-h-0 让列表自适应高度 */}
      <div class="mt-4 flex flex-1 min-h-0 min-w-0 flex-col gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Show
          when={props.projects.length > 0}
          fallback={
            <button
              type="button"
              class={`${HOME_PROJECT_NAV_ROW} text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
              onClick={props.chooseProject}
            >
              <IconV2 name="folder-add-left" size="small" />
              <span>{props.language.t("home.project.add")}</span>
            </button>
          }
        >
          <For each={props.projects}>
            {(project) => (
              <ContextMenu>
                <ContextMenu.Trigger
                  as="button"
                  type="button"
                  data-component="home-project-row"
                  data-action="home-project-row"
                  data-project={base64Encode(project.worktree)}
                  class={HOME_PROJECT_NAV_ROW}
                  classList={{ "bg-v2-overlay-simple-overlay-hover": props.selected === project.worktree }}
                  data-selected={props.selected === project.worktree ? "" : undefined}
                  aria-current={props.selected === project.worktree ? "page" : undefined}
                  onClick={() => props.selectProject(project.worktree)}
                >
                  <HomeProjectAvatar project={project} />
                  <span>{displayName(project)}</span>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content>
                    {/* 260710 Red 在文件管理器中打开项目目录 */}
                    <ContextMenu.Item
                      data-action="home-project-reveal"
                      data-project={base64Encode(project.worktree)}
                      onSelect={() => platform.openPath?.(project.worktree)}
                    >
                      <ContextMenu.ItemLabel>{props.language.t("home.project.revealInExplorer")}</ContextMenu.ItemLabel>
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      data-action="home-project-remove"
                      data-project={base64Encode(project.worktree)}
                      onSelect={() => props.removeProject(project)}
                    >
                      <ContextMenu.ItemLabel>{props.language.t("common.delete")}</ContextMenu.ItemLabel>
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu>
            )}
          </For>
        </Show>
      </div>
      {/* 260709 Red 左栏底部吸底：StatsPanel + 设置按钮固定在左栏最下方，不随项目列表滚动 */}
      <div class="mt-auto shrink-0">
        <HomeStatsPanel sessions={props.statsSessions} />
        <div class="mt-2 flex min-w-0 flex-col gap-1">
          <button
            type="button"
            class={`${HOME_PROJECT_NAV_ROW} text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
            onClick={props.openSettings}
          >
            <IconV2 name="settings-gear" size="small" />
            <span>{props.language.t("sidebar.settings")}</span>
          </button>
        </div>
      </div>
    </aside>
  )
}

function HomeProjectAvatar(props: { project: LocalProject }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <AvatarV2
      fallback={name()}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      kind="org"
      size="small"
      {...getAvatarColors(props.project.icon?.color)}
      class="size-4 rounded"
    />
  )
}

function HomeSessionSearch(props: { ref?: (el: HTMLInputElement) => void; value: string; placeholder: string; onInput: (value: string) => void }) {
  const isMac = navigator.platform.includes("Mac")
  const modKey = isMac ? "⌘" : "Ctrl"
  let inputRef: HTMLInputElement | undefined
  return (
    <label class="ml-4 flex h-9 w-[calc(100%_-_48px)] sticky top-0 inset-x-0 items-center gap-2 rounded-[6px] bg-v2-background-bg-deep px-3 py-1 text-v2-icon-icon-muted transition-[background-color,box-shadow] duration-[120ms] ease-in-out focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_0.5px_var(--v2-border-border-focus),var(--v2-elevation-raised)]">
      <IconV2 name="magnifying-glass" size="small" />
      <input
        ref={(el) => { inputRef = el; props.ref?.(el) }}
        class="min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <kbd class="hidden sm:inline-flex items-center gap-0.5 rounded border border-v2-border-border-base px-1.5 py-0.5 text-[10px] font-medium text-v2-text-text-muted tabular-nums">
        {modKey}+K
      </kbd>
    </label>
  )
}

function HomeSessionGroupHeader(props: { title: string; onNewSession?: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex h-7 min-w-0 items-center justify-between px-4">
      <div class={HOME_SECTION_LABEL}>{props.title}</div>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2
            data-action="home-new-session"
            variant="ghost"
            size="normal"
            icon="edit"
            class="h-7 px-2 text-v2-text-text-muted [font-weight:530]"
            onClick={onNewSession()}
          >
            {language.t("command.session.new")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionRow(props: {
  record: HomeSessionRecord
  openSession: (session: Session) => void
  onArchive: (session: Session) => void
}) {
  const globalSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const language = useLanguage()
  const [sessionStore] = globalSync.child(props.record.session.directory, { bootstrap: false })
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const unseenCount = createMemo(() => notification.session.unseenCount(props.record.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.record.session.id))
  const hasPermissions = createMemo(
    () =>
      !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.record.session.id, (item) => {
        return !permission.autoResponds(item, props.record.session.directory)
      }),
  )
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return sessionStore.session_working(props.record.session.id)
  })
  const tint = createMemo(() => messageAgentColor(sessionStore.message[props.record.session.id], sessionStore.agent))
  const showStatus = createMemo(() => isWorking() || hasPermissions() || hasError() || unseenCount() > 0)

  return (
    // 260710 Red 会话右键菜单：归档
    <ContextMenu>
      <ContextMenu.Trigger
        as="button"
        type="button"
        data-component="home-session-row"
        class={`${HOME_ROW} h-10 gap-2 px-6 py-3 pl-4`}
        onClick={() => props.openSession(props.record.session)}
      >
        <Show when={showStatus()}>
          <div
            class="flex size-4 shrink-0 items-center justify-center"
            style={{ color: tint() ?? "var(--icon-interactive-base)" }}
          >
            <Switch>
              <Match when={isWorking()}>
                <Spinner class="size-[15px]" />
              </Match>
              <Match when={hasPermissions()}>
                <div class="size-1.5 rounded-full bg-surface-warning-strong" />
              </Match>
              <Match when={hasError()}>
                <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
              </Match>
              <Match when={unseenCount() > 0}>
                <div class="size-1.5 rounded-full bg-text-interactive-base" />
              </Match>
            </Switch>
          </div>
        </Show>
        <span
          class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] ${props.record.projectName ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={props.record.projectName}>
          <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]">
            {props.record.projectName}
          </span>
        </Show>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => props.onArchive(props.record.session)}>
            <ContextMenu.ItemLabel>{language.t("command.session.archive")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between px-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}</For>
      </div>
    </div>
  )
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")

  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

