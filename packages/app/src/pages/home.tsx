import type { Session } from "@redcode-ai/sdk/v2/client"
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Binary } from "@redcode-ai/core/util/binary"
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
import { tallySessionStatus } from "@/utils/session-status"
import { pickGreetingKey } from "@/utils/greeting"
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
  // 260814 Red archived：归档只是打 time_archived 时间戳 + 列表默认过滤（session.ts 的 list），
  //   数据一个字节都不删。此前 GUI 只有"归档"没有"看已归档/取消归档"，归档等于单向消失——
  //   实测 432 个会话里只归档过 1 个。这里补齐可见性与撤销。
  const [state, setState] = createStore({
    search: "",
    project: undefined as string | undefined,
    view: "kanban" as "list" | "kanban",
    archived: false,
  })
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

  // 260814 Red 已归档会话不进 sync store（global-sync 拉取时就滤掉了），只能单独取。
  //   archived:true 的语义是"不加 IS NULL 过滤"即**包含**归档，所以这里再筛出真正带
  //   time.archived 的那些。仅在开关打开时请求，关掉不产生任何额外负载。
  const archivedLoad = useQuery(() => ({
    queryKey: ["home", "archived", selectedProject()?.worktree, state.archived] as const,
    enabled: state.archived,
    queryFn: async () => {
      const project = selectedProject()
      if (!project) return [] as Session[]
      const res = await globalSDK.client.experimental.session.list({
        directory: project.worktree,
        roots: true,
        archived: true,
        limit: HOME_SESSION_LIMIT,
      })
      return ((res.data ?? []) as Session[]).filter((s) => !!s.time?.archived)
    },
  }))

  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const records = createMemo(() =>
    [
      ...new Map(
        (state.archived
          ? (archivedLoad.data ?? [])
          : projectDirectories().flatMap((directory) =>
              sortedRootSessions(sync.child(directory, { bootstrap: false })[0], Date.now()),
            )
        ).map((session) => [`${pathKey(session.directory)}:${session.id}`, session] as const),
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
  // 260814 Red 修「点了没反应」：原来既没传 directory 也没动本地 store。
  //   1) session.update 是实例级路由，缺 directory 时服务端回落 process.cwd()
  //      （workspace-routing.ts 的 defaultDirectory），于是 session.updated 事件
  //      被发到那个目录的频道上，首页按 session.directory 分片的 store 永远收不到；
  //   2) 即便事件到了也该先落本地——directory-sync 的 archive 就是「调 API + 立即
  //      从 store 摘掉」两步，这里对齐它。
  function dropFromStore(session: Session) {
    const [, setStore] = sync.child(session.directory)
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
  }

  async function archiveSession(session: Session) {
    await globalSDK.client.session.update({
      sessionID: session.id,
      directory: session.directory,
      time: { archived: Date.now() },
    })
    dropFromStore(session)
  }

  // 260814 Red 取消归档：清掉 time_archived，会话立刻回到正常列表。
  //   用独立的 unarchive 字段而非 time.archived:null——原因见服务端 UpdatePayload 的注释
  //   （OpenAPI 生成器会把 payload 里的联合类型压平，null 传不过来）。
  //   取消后刷新归档列表，让它从"已归档"视图里消失。
  async function unarchiveSession(session: Session) {
    await globalSDK.client.session.update({
      sessionID: session.id,
      directory: session.directory,
      unarchive: true,
    })
    await archivedLoad.refetch()
    // 让它重新出现在正常列表里（归档时已从 store 摘掉，事件回不来就得主动拉）
    await sync.project.loadSessions(session.directory)
  }

  return (
    <div class="grid w-full h-full gap-x-6 pr-6 lg:grid-cols-[220px_minmax(0,1fr)] grid-rows-[1fr_auto]">
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
          {/* 260814 Red 已归档视图开关：打开后列表换成归档会话（单独请求，见 archivedLoad） */}
          <IconButtonV2
            data-action="home-toggle-archived"
            variant={state.archived ? "contrast" : "ghost-muted"}
            size="large"
            icon={<IconV2 name="archive" size="small" />}
            onClick={() => setState("archived", !state.archived)}
            aria-label={language.t("home.sessions.archived.toggle")}
            aria-pressed={state.archived}
            class="size-7 shrink-0"
          />
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
                    <div class="text-14-normal font-medium text-v2-text-text-base">
                      {language.t(state.archived ? "home.sessions.archived.empty" : "home.sessions.empty")}
                    </div>
                    <Show when={!state.archived}>
                      <div class="text-12-regular text-v2-text-text-muted">{language.t("command.session.new")}</div>
                    </Show>
                  </div>
                  {/* 归档视图为空时不提示"新建会话"——那不是这个视图该做的事 */}
                  <Show when={!state.archived}>
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
                  </Show>
                </div>
              }
            >
              <Switch>
                <Match when={state.view === "kanban"}>
                  <HomeKanban
                    records={records()}
                    selectedProjectName={selectedProject() ? displayName(selectedProject()!) : undefined}
                    openSession={openSession}
                    onArchive={archiveSession}
                    onUnarchive={(session) => void unarchiveSession(session)}
                  />
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
                              {(record) => (
                                <HomeSessionRow
                                  record={record}
                                  openSession={openSession}
                                  onArchive={archiveSession}
                                  onUnarchive={(session) => void unarchiveSession(session)}
                                />
                              )}
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

// 260710 Red 首页底部：随机 tips + 快捷键提示条
// 260811 Red 只占内容列（lg:col-start-2），侧边栏跨两行延伸到底
// 260828 cc 轮播 tips 整套下线，换成与新建会话页同一组按时段问候（utils/greeting）。
//
// 下线的东西与理由：
// · **每 20 分钟一次 /experimental/generate 调用** —— 为了一行装饰文字，在常驻界面上
//   持续烧模型调用。这是本轮唯一一处「界面自己主动花钱」的地方。
// · **50 条本地 tips 库** —— 其中约七条教的快捷键正下方那行图例里就写着，本来就是重复；
//   而且它此前实际是死的（memo 里的 Math.random() 只在挂载时抽一次，几秒后就被生成的
//   那条永久顶掉），今天上午刚修好又整个删掉，前后不到半天。
// · 随之删掉的还有我上午为了消重复而写的 shortcutKeys 过滤 —— 换成问候语之后，
//   与快捷键条重复这件事从根上不存在了，那段代码没了存在理由。
function HomeShortcutBar() {
  const language = useLanguage()
  const isMac = navigator.platform.includes("Mac")
  const mod = isMac ? "⌘" : "Ctrl"
  const shortcuts = [
    { keys: `${mod}+K`, label: language.t("home.shortcuts.search") },
    { keys: `${mod}+N`, label: language.t("home.shortcuts.newSession") },
    { keys: `Alt+↑↓`, label: language.t("home.shortcuts.switchSession") },
    { keys: `${mod}+Alt+↑↓`, label: language.t("home.shortcuts.switchProject") },
    { keys: `${mod}+O`, label: language.t("home.shortcuts.openProject") },
    { keys: `${mod}+\\`, label: language.t("home.shortcuts.fileTree") },
    { keys: `${mod}+,`, label: language.t("home.shortcuts.settings") },
    { keys: `${mod}+P`, label: language.t("home.shortcuts.commandPalette") },
    { keys: `${mod}+Shift+T`, label: language.t("home.shortcuts.cycleTheme") },
    { keys: `${mod}+Shift+⌫`, label: language.t("home.shortcuts.archiveSession") },
  ]
  // 进页面抽一次。用 createSignal 不用 createMemo —— 理由见 utils/greeting.ts。
  const [greetingKey] = createSignal(pickGreetingKey(new Date().getHours()))
  const tip = () => language.t(greetingKey())

  // 260810 cc audit R9: 原硬编码 #4ade80 带 60%/80% alpha，浅色三主题（light/cream/green)
  // 下对比度约 1.5:1 基本不可读；改语义 token（明 green-800/暗 green-500）保住绿色系
  // 人格化设计且随主题走。快捷键行补 flex-wrap，窄窗不再溢出裁切。
  return (
    <div class="col-span-full lg:col-start-2 flex flex-col items-center gap-1.5 px-4 pt-3 pb-5">
      <span class="text-[14px] [font-weight:440] italic text-v2-state-fg-success">{tip()}</span>
      <div class="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-[13px] [font-weight:440] text-v2-state-fg-success">
        <For each={shortcuts}>
          {(item) => (
            <span class="flex items-center gap-1">
              <span class="text-[12px] [font-weight:530]">{item.keys}</span>
              <span>{item.label}</span>
            </span>
          )}
        </For>
      </div>
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
      class="flex min-w-0 flex-col lg:row-span-full lg:pt-[52px] lg:border-r lg:border-v2-border-border-base lg:bg-v2-background-bg-layer-01 lg:pr-6"
      data-frost-surface="home-sidebar"
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
                  <HomeProjectStatus project={project} />
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

// 260828 cc 项目行的运行态指示。
//
// 12 个项目排在侧边栏里，此前只有色块头像 + 名字 —— 哪个有会话在跑、哪个有权限请求
// 等着你，必须逐个点进去才知道。而看板早就把这个分类算出来了（现在两边共用
// @/utils/session-status 的判据）。
//
// **必须用 peek 不是 child**：`child()` 无条件 pinForOwner，把目录永久钉住，重连时
// 「只刷新 pinned 目录」的过滤形同虚设（layout.tsx 的 enrich() 上方那条注释记的就是这个
// 坑）。首个版本用了 child，侧边栏对 12 个项目各调一次，实测触发 12 次串行 session.list、
// 累计 28 秒 —— 期间首页一条会话都显示不出来。`peek()` 只读已经在内存里的 store，不 pin、
// 不触发 InstanceStore.load()。代价是从没打开过的项目这里什么都不显示 —— 那是对的，
// 我们确实不知道，也不该为了点亮一个小点去把整套 MCP/LSP 进程树拉起来。
function HomeProjectStatus(props: { project: LocalProject }) {
  const sync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const tally = createMemo(() => {
    const [store] = sync.peek(props.project.worktree, { bootstrap: false })
    const sessions = (store.session ?? []).filter((session) => !session.time?.archived)
    if (sessions.length === 0) return undefined
    return tallySessionStatus(sessions, { sync, notification, permission })
  })
  return (
    <span class="ml-auto flex shrink-0 items-center gap-1.5">
      <Show when={(tally()?.working ?? 0) > 0}>
        <Spinner class="size-[11px] text-v2-icon-icon-info" />
      </Show>
      <Show when={(tally()?.attention ?? 0) > 0}>
        <span class="flex items-center gap-1 text-[11px] [font-weight:530] text-v2-icon-icon-warning">
          <span class="size-1.5 rounded-full bg-surface-warning-strong" />
          {tally()!.attention}
        </span>
      </Show>
    </span>
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

function HomeSessionSearch(props: {
  ref?: (el: HTMLInputElement) => void
  value: string
  placeholder: string
  onInput: (value: string) => void
}) {
  const isMac = navigator.platform.includes("Mac")
  const modKey = isMac ? "⌘" : "Ctrl"
  let inputRef: HTMLInputElement | undefined
  return (
    <label class="ml-4 flex h-9 w-[calc(100%_-_48px)] sticky top-0 inset-x-0 items-center gap-2 rounded-[6px] bg-v2-background-bg-deep px-3 py-1 text-v2-icon-icon-muted transition-[background-color,box-shadow] duration-[120ms] ease-in-out focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_0.5px_var(--v2-border-border-focus),var(--v2-elevation-raised)]">
      <IconV2 name="magnifying-glass" size="small" />
      <input
        ref={(el) => {
          inputRef = el
          props.ref?.(el)
        }}
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
  onUnarchive?: (session: Session) => void
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
          {/* 260814 Red 已归档的行给"取消归档"，未归档的给"归档" */}
          <ContextMenu.Item
            onSelect={() =>
              props.record.session.time?.archived
                ? props.onUnarchive?.(props.record.session)
                : props.onArchive(props.record.session)
            }
          >
            <ContextMenu.ItemLabel>
              {language.t(
                props.record.session.time?.archived ? "command.session.unarchive" : "command.session.archive",
              )}
            </ContextMenu.ItemLabel>
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
