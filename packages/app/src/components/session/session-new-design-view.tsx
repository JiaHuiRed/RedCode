import type { JSX } from "solid-js"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import type { Session } from "@redcode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { useServerSync } from "@/context/server-sync"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { useSettings } from "@/context/settings"
import { pickGreetingKey } from "@/utils/greeting"
import { compareSessionTime, sortedRootSessions } from "@/utils/session-helpers"
import { classifySession } from "@/utils/session-status"
import { sessionTitleParts } from "@/utils/session-title"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { getFilename } from "@redcode-ai/core/util/path"
import { Icon } from "@redcode-ai/ui/icon"
import { Spinner } from "@redcode-ai/ui/spinner"
import { Select } from "@redcode-ai/ui/select"
import { DropdownMenu } from "@redcode-ai/ui/dropdown-menu"
import { Button } from "@redcode-ai/ui/button"
import { SoulAvatar } from "@/components/soul-avatar"
import { isCodeSession } from "@/utils/product-mode"
import { chooseCodeSoul } from "@/utils/code-soul"
import { WordmarkV2 } from "@redcode-ai/ui/v2/components/wordmark-v2.jsx"
import { readSessionDraft, sessionNextAction } from "./session-next-action"

const MAIN_WORKTREE = "main"

// 261116 Red B03：新会话页只放 3—5 条最近任务；再多就成了第二个首页。
const RECENT_LIMIT = 5

export function NewSessionDesignView(props: {
  worktree: string
  children: JSX.Element
  // 261114 Red UX-03 评审：Soul 选择从输入区工具栏挪到上下文行，状态由 session.tsx 持有
  newSessionSoul?: () => string | undefined
  onNewSessionSoulChange?: (id: string | undefined) => void
}) {
  const globalSync = useServerSync()
  const layout = useLayout()
  const navigate = useNavigate()
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const sync = useSync()
  const language = useLanguage()
  const settings = useSettings()
  const notification = useNotification()
  const permission = usePermission()
  const dialog = useDialog()
  const [greetingKey] = createSignal(pickGreetingKey(new Date().getHours()))

  // 261114 Red UX-03：Soul 快选（跟随设置默认 / 全阵容 / 设为默认 / 管理），
  // 逻辑与原工具栏版一致，只是位置移到上下文行。
  const soulList = useQuery(() => ({
    queryKey: ["soul", globalSDK.url, "list"],
    queryFn: async () => (await globalSDK.client.soul.list({ throwOnError: true })).data,
  }))
  const companionList = useQuery(() => ({
    queryKey: ["companion", globalSDK.url, "list"],
    queryFn: async () => (await globalSDK.client.companion.list({ throwOnError: true })).data,
  }))
  const defaultSoul = useQuery(() => ({
    queryKey: ["soul", globalSDK.url, "default", "desktop"],
    queryFn: async () => (await globalSDK.client.soul.default({ client: "desktop" }, { throwOnError: true })).data,
  }))
  const codeSouls = createMemo(() => {
    if (!companionList.data) return []
    const bound = new Set(companionList.data.map((profile) => profile.soulID))
    return (soulList.data ?? []).filter((soul) => !bound.has(soul.id))
  })
  const effectiveSoulID = createMemo(() => {
    if (!companionList.data || !soulList.data) return undefined
    return chooseCodeSoul({
      saved: props.newSessionSoul?.() ?? settings.personalization.lastSoul(),
      serverDefault: defaultSoul.data?.id,
      souls: soulList.data,
      companions: companionList.data,
    })
  })
  const currentSoul = createMemo(() => codeSouls().find((soul) => soul.id === effectiveSoulID()))

  const projectRoot = createMemo(() => sync.project?.worktree ?? sdk.directory)
  const projects = createMemo(() => {
    const roots = globalSync.data.project.map((project) => project.worktree)
    if (roots.includes(projectRoot())) return roots
    return [projectRoot(), ...roots]
  })
  const branch = createMemo(() => sync.data.vcs?.branch ?? MAIN_WORKTREE)

  const openProject = (directory: string | undefined) => {
    if (!directory) return
    if (directory === projectRoot()) return
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}/session`)
  }

  // 261116 Red B03：当前项目（含 sandbox）最近 3—5 个任务，作为「继续已有任务」的轻量入口。
  // 根会话过滤与排序复用首页同一套 helper；peek 只读内存 store，不为列表 bootstrap 目录。
  const recentTasks = createMemo((): Session[] => {
    const dirs = [projectRoot(), ...(sync.project?.sandboxes ?? [])]
    const seen = new Set<string>()
    return dirs
      .flatMap((dir) => sortedRootSessions(globalSync.peek(dir, { bootstrap: false })[0], Date.now()))
      .filter((session) => {
        if (!isCodeSession(session) || seen.has(session.id)) return false
        seen.add(session.id)
        return true
      })
      .sort(compareSessionTime)
      .slice(0, RECENT_LIMIT)
  })

  // 继续入口落到具体会话，而不是只回项目首页。项目行固定开当前项目根，
  // sandbox 里的会话不会被当成新项目塞进侧栏。
  // 261116 Red B03：有草稿的行带 ?focus=prompt —— 由 session.tsx 消费后把光标送回输入框
  // （契约：读 searchParams.focus === "prompt" 时调已有的 focusInput() 并清掉该参数）。
  // 消费者未落地前该参数无副作用，草稿本身仍会随会话恢复。
  const openRecent = (session: Session, focus?: "prompt") => {
    const root = projectRoot()
    layout.projects.open(root)
    server.projects.touch(root)
    navigate(`/${base64Encode(session.directory)}/session/${session.id}${focus ? "?focus=prompt" : ""}`)
  }

  // 260814 Red 毛玻璃 B 遗漏点：下面这层的实色底盖住了整窗壁纸，新建会话页黑成一块
  // （会话页 #session-root / #session-chat-panel 已于 260813 清底，独漏这个容器）。
  // 清底交给 index.css 的 [data-app-frost] [data-component="session-new-design"] 规则，
  // 无壁纸时这里的实色照常生效。
  return (
    <main
      data-component="session-new-design"
      class="relative size-full overflow-hidden bg-v2-background-bg-deep"
      aria-label={language.t("command.session.new")}
    >
      {/* 260828 cc 原来是 `absolute inset-x-0 top-[25.375%]` —— 一个精确到小数点后三位的
          百分比，像是照着某个特定窗口高度的设计稿量出来的。它把整块钉死在上四分之一：
          1100px 高的窗口里内容到 500px 就结束，下面 600px 全空，而且窗口越高空白越大。
          改成 flex 垂直居中、再用 pb 往上偏一点（输入框略高于正中读起来更稳），跟窗口
          高度走。 */}
      <div class="flex size-full flex-col items-center justify-center px-6 pb-[10vh]">
        <div class="w-full max-w-[720px]">
          {/* 260828 cc 容器宽度保持 720 —— 试过拓到 820 让模型芯片少截断一点，结果输入框
              有它自己的宽度约束、没跟着变宽，底下的项目/分支那行按外层宽度起头就顶到输入框
              左边去了（哥哥的原话是「冒出头了」）。要放宽得先改输入框自己的约束，不在这一层。 */}
          <div class="text-center">
            {/* 261118 RedSpace 八字母字标：响应式字号不超出 720px 主列，
                保留原组件逐字母入场与减少动态效果偏好。 */}
            <WordmarkV2 class="text-[clamp(30px,8vw,82px)] leading-none" />
          </div>
          {/* 260828 cc 问候语。字标是品牌、输入框是功能，中间这一句是唯一说人话的地方，
              所以放这儿。字号刻意压在 15px：它是陪衬，抢了输入框的注意力就本末倒置了。 */}
          <h1 class="mt-5 text-center text-[15px] font-[440] text-v2-text-text-muted">{language.t(greetingKey())}</h1>
          <div class="mt-8">
            {props.children}
            {/* 260920 Red 把项目选择与当前分支归为一组上下文元信息，和主输入保持一条
                清晰的分隔线；它们是开始前的选择，不再和提交动作抢同一层级。 */}
            <div
              data-component="new-session-context"
              class="mt-4 flex min-h-8 flex-wrap items-center gap-0 border-t border-v2-border-border-base/50 pl-2 pt-2"
              aria-label={language.t("command.session.new")}
            >
              {/* 261114 Red UX-03 评审：Soul 选择器与工作区归入同一行上下文元信息，
                  输入区工具栏不再拥挤（此前挤成两行）。 */}
              <DropdownMenu gutter={4} placement="top-start">
                <DropdownMenu.Trigger
                  as={Button}
                  type="button"
                  variant="ghost"
                  size="normal"
                  class="max-w-[203px] justify-start gap-1.5"
                  data-action="prompt-soul"
                  aria-label={language.t("prompt.soul.title")}
                >
                  <Show
                    when={currentSoul()}
                    fallback={<Icon name="brain" size="small" class="text-v2-icon-icon-muted shrink-0" />}
                  >
                    <SoulAvatar soul={currentSoul()!} size="small" />
                  </Show>
                  <span class="truncate text-[13px] font-[440] text-v2-text-text-faint">
                    {currentSoul()?.displayName || currentSoul()?.name || language.t("prompt.soul.default")}
                  </span>
                  <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content style={{ "max-height": "320px", "overflow-y": "auto", "min-width": "200px" }}>
                    <DropdownMenu.Group>
                      <DropdownMenu.GroupLabel class="text-12-medium text-text-weak">
                        {language.t("prompt.soul.title")}
                      </DropdownMenu.GroupLabel>
                      <DropdownMenu.Item onSelect={() => props.onNewSessionSoulChange?.(undefined)}>
                        <DropdownMenu.ItemLabel>
                          <Show when={!props.newSessionSoul?.()}>✓ </Show>
                          {language.t("prompt.soul.followDefault")}
                        </DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <For each={codeSouls()}>
                        {(soul) => (
                          <DropdownMenu.Item onSelect={() => props.onNewSessionSoulChange?.(soul.id)}>
                            <DropdownMenu.ItemLabel class="flex items-center gap-2">
                              <Show when={effectiveSoulID() === soul.id}>✓ </Show>
                              <SoulAvatar soul={soul} size="small" />
                              <span class="truncate">{soul.displayName || soul.name}</span>
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        )}
                      </For>
                    </DropdownMenu.Group>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      disabled={!effectiveSoulID() || effectiveSoulID() === settings.personalization.lastSoul()}
                      onSelect={() => {
                        const id = effectiveSoulID()
                        if (id) settings.personalization.setLastSoul(id)
                      }}
                    >
                      <DropdownMenu.ItemLabel>{language.t("prompt.soul.setDefault")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() => {
                        void import("@/components/dialog-settings").then((m) => {
                          dialog.show(() => <m.DialogSettings initialTab="personalization" />)
                        })
                      }}
                    >
                      <DropdownMenu.ItemLabel>{language.t("prompt.soul.manage")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
              <Select
                size="normal"
                variant="ghost"
                options={projects()}
                current={projectRoot()}
                label={getFilename}
                onSelect={openProject}
                class="max-w-[203px] justify-start text-text-base [&_[data-component=icon]]:text-v2-icon-icon-muted"
                valueClass="truncate text-[length:13px] font-[440] text-v2-text-text-faint"
                // 261116 Red B03：长路径可确认完整信息（名字被截断时悬停即见绝对路径）。
                triggerProps={{ title: projectRoot() }}
              />
              {/* 260828 cc 原来这里是个 <Select>，但 options 只有 `[branch()]` 一个元素、
                  也没有 onSelect —— 渲染出下拉箭头、看起来能点，点开只有它自己、选了没反应。
                  vcs 数据里根本没有分支列表（sync.data.vcs 只有当前 branch），所以它不可能
                  是"待接线"，就是个假控件。退成静态标签：图标 + 文字，不再摆出可交互的样子。
                  副作用是好的 —— 上面那个 worktree 芯片仍有箭头，两者一眼就分得开了。 */}
              <div class="flex h-7 max-w-[240px] items-center gap-1.5 px-2 text-v2-text-text-faint">
                <Icon name="branch" size="small" />
                <span class="truncate text-[13px] font-[440]">{branch()}</span>
              </div>
            </div>
            {/* 261116 Red B03：最近任务 =「继续已有任务」，与上方输入（开始新任务）分开。
                只放轻量文本行，不加卡片；加载/为空时整块不渲染，保持字标与输入区的视觉中心。 */}
            <Show when={recentTasks().length > 0}>
              <div data-component="new-session-recent" class="mt-3" aria-label={language.t("session.new.recent.title")}>
                <div class="flex min-w-0 items-baseline gap-2 px-2 pb-0.5">
                  <span class="shrink-0 text-sm [font-weight:530] text-v2-text-text-muted">
                    {language.t("session.new.recent.title")}
                  </span>
                  <span class="min-w-0 truncate text-sm [font-weight:440] text-v2-text-text-faint">
                    {language.t("session.new.recent.hint")}
                  </span>
                </div>
                <div class="flex flex-col">
                  <For each={recentTasks()}>{(session) => <RecentTaskRow session={session} onOpen={openRecent} />}</For>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </main>
  )
}

// 261116 Red B03：最近任务行——标题 + 一条真实行动信息，点击直接进入该会话。
// 运行时状态优先（提问/授权/出错/未读），都没有时才读一次已落盘草稿（见 session-next-action）。
function RecentTaskRow(props: { session: Session; onOpen: (session: Session, focus?: "prompt") => void }) {
  const globalSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const platform = usePlatform()
  const language = useLanguage()
  const deps = { sync: globalSync, notification, permission }
  const title = createMemo(() => sessionTitleParts(props.session.title).text || props.session.id)
  const action = createMemo(() => sessionNextAction(props.session, deps))
  const [draft] = createResource(
    () => (action() ? null : props.session),
    (session) => readSessionDraft(session.directory, session.id, platform),
  )
  const working = createMemo(() => classifySession(props.session, deps) === "working")

  const entry = createMemo((): { label: string; tone: string; dot?: string; spinner?: boolean } => {
    const info = action()
    if (info?.kind === "question") {
      return {
        label: language.t("session.action.viewQuestion"),
        tone: "text-v2-state-fg-warning",
        dot: "bg-v2-state-fg-warning",
      }
    }
    if (info?.kind === "permission") {
      return {
        label: language.t("session.action.viewApproval"),
        tone: "text-v2-state-fg-warning",
        dot: "bg-v2-state-fg-warning",
      }
    }
    if (info?.kind === "error") {
      return {
        label: language.t("session.action.viewError"),
        tone: "text-v2-state-fg-danger",
        dot: "bg-v2-state-fg-danger",
      }
    }
    if (info?.kind === "unseen") {
      return {
        label: language.t("session.action.viewResult"),
        tone: "text-v2-state-fg-info",
        dot: "bg-v2-state-fg-info",
      }
    }
    if (draft()) {
      return {
        label: language.t("session.action.resumeDraft"),
        tone: "text-v2-text-text-muted",
        dot: "bg-v2-text-text-muted",
      }
    }
    if (working()) {
      return { label: language.t("home.session.status.working"), tone: "text-v2-text-text-faint", spinner: true }
    }
    return { label: language.t("common.continue"), tone: "text-v2-text-text-faint" }
  })

  return (
    <button
      type="button"
      data-component="new-session-recent-task"
      class="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
      onClick={() => props.onOpen(props.session, draft() ? "prompt" : undefined)}
    >
      <span class="flex size-3.5 shrink-0 items-center justify-center">
        <Show
          when={entry().spinner}
          fallback={<span class={`size-1.5 rounded-full ${entry().dot ?? "bg-transparent"}`} />}
        >
          <Spinner class="size-[13px]" />
        </Show>
      </span>
      <span class="min-w-0 flex-1 truncate text-sm [font-weight:440] text-v2-text-text-faint">{title()}</span>
      <span class={`shrink-0 text-sm [font-weight:440] ${entry().tone}`}>{entry().label}</span>
    </button>
  )
}
