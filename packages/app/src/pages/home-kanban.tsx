import type { Session } from "@redcode-ai/sdk/v2/client"
import { DateTime } from "luxon"
import { createMemo, For, Show } from "solid-js"
import { Spinner } from "@redcode-ai/ui/spinner"
import { ContextMenu } from "@redcode-ai/ui/context-menu"
import { Icon as IconV2 } from "@redcode-ai/ui/v2/components/icon.jsx"
import { useServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { sessionTitleParts } from "@/utils/session-title"
import { messageAgentColor } from "@/utils/agent"
import { classifySession } from "@/utils/session-status"
import type { LocalProject } from "@/context/layout"

type KanbanRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

type KanbanColumn = {
  id: "working" | "attention" | "idle"
  records: KanbanRecord[]
}

// 260615 Red Kanban 看板视图：按会话运行状态分列（工作中/需关注/空闲）
export function HomeKanban(props: {
  records: KanbanRecord[]
  /** 当前选中的项目名。卡片只在自己不属于它时才印项目名 —— 否则那是个常量。 */
  selectedProjectName?: string
  openSession: (session: Session) => void
  onArchive: (session: Session) => void
  onUnarchive?: (session: Session) => void
}) {
  const globalSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const language = useLanguage()

  const columns = createMemo((): KanbanColumn[] => {
    const working: KanbanRecord[] = []
    const attention: KanbanRecord[] = []
    const idle: KanbanRecord[] = []

    // 260828 cc 判据搬到 @/utils/session-status —— 侧边栏的项目运行态指示要用同一套规则，
    // 各写一份必然漂（看板说"需关注"、侧边栏不亮点，或者反过来）。
    const deps = { sync: globalSync, notification, permission }
    for (const record of props.records) {
      const status = classifySession(record.session, deps)
      if (status === "working") working.push(record)
      else if (status === "attention") attention.push(record)
      else idle.push(record)
    }

    return [
      { id: "working", records: working },
      { id: "attention", records: attention },
      { id: "idle", records: idle },
    ]
  })

  const columnLabel = (id: KanbanColumn["id"]) => {
    if (id === "working") return language.t("home.kanban.working")
    if (id === "attention") return language.t("home.kanban.attention")
    return language.t("home.kanban.idle")
  }

  const columnColor = (id: KanbanColumn["id"]) => {
    if (id === "working") return "var(--v2-icon-icon-info, var(--syntax-info))"
    if (id === "attention") return "var(--v2-icon-icon-warning, var(--surface-warning-strong))"
    return "var(--v2-text-text-muted, var(--text-weak))"
  }

  return (
    <div class="flex gap-4 min-h-0 overflow-x-auto overflow-y-hidden flex-1 px-4 pb-4">
      <For each={columns()}>
        {(column) => (
          // 260828 cc 空列不再与有内容的列等宽。原来每列都是 `flex-1`：宽窗口下
          // 「工作中」「需关注」各占三分之一全是虚线占位，唯一有内容的列被挤在剩下的
          // 三分之一里。改成空列只占最小宽度、不参与 grow，横向空间全给有内容的列。
          <div
            class="flex flex-col min-w-[220px] gap-3"
            style={{ flex: column.records.length > 0 ? "1 1 0%" : "0 1 220px" }}
          >
            <div class="flex items-center gap-2 px-2 h-7 shrink-0">
              <div class="size-2 rounded-full" style={{ "background-color": columnColor(column.id) }} />
              <span class="text-v2-text-text-muted [font-weight:530] text-[13px]">{columnLabel(column.id)}</span>
              {/* 260828 cc 计数改成三列都显示。原来只在 > 0 时给，于是「工作中」「需关注」
                  没数字、「空闲」有个 5，三个列头的信息密度不齐，扫视时会卡一下。
                  而且 0 本身是信息 —— 「需关注 0」是个正面信号，不是没内容。 */}
              <span class="text-v2-text-text-faint text-[11px] [font-weight:440]">{column.records.length}</span>
            </div>
            {/* 260828 cc 卡片列数按可用宽度自适应，不再按记录条数切换。原判据是
                records.length > 6 才切两列，但决定该排几列的是宽度不是条数：5 张卡在宽列里
                各占满整行，一张卡 500+px 只装一行标题。auto-fill + minmax 让窄列自然退化成
                一列、宽列自动铺开，不需要阈值。 */}
            <div class="overflow-y-auto flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2 auto-rows-min content-start">
              <Show
                when={column.records.length > 0}
                fallback={
                  // 260828 cc 空态从 py-6 的虚线大盒子改成一行淡字。列收窄之后那个盒子
                  // 仍是整屏最显眼的两个矩形之一，而它承载的信息是「这里没有东西」。
                  <div class="px-2 py-1 text-[12px] text-v2-text-text-faint [font-weight:440]">
                    {language.t("home.kanban.empty")}
                  </div>
                }
              >
                <For each={column.records}>
                  {(record) => (
                    <KanbanCard
                      record={record}
                      columnId={column.id}
                      selectedProjectName={props.selectedProjectName}
                      onClick={() => props.openSession(record.session)}
                      onArchive={() => props.onArchive(record.session)}
                      onUnarchive={() => props.onUnarchive?.(record.session)}
                    />
                  )}
                </For>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

function KanbanCard(props: {
  record: KanbanRecord
  columnId: KanbanColumn["id"]
  selectedProjectName?: string
  onClick: () => void
  onArchive: () => void
  onUnarchive?: () => void
}) {
  const globalSync = useServerSync()
  const language = useLanguage()
  const [store] = globalSync.child(props.record.session.directory, { bootstrap: false })
  // 260828 cc 人格前缀（`[宋雨琦] …`）从标题里拆出来降到第二行。同一批卡片的前缀几乎
  // 恒等，留在标题开头等于让一个常量占掉每张卡最值钱的那几个字符。
  const parts = createMemo(() => sessionTitleParts(props.record.session.title))
  const title = createMemo(() => parts().text || props.record.session.id)
  // 260828 cc 项目名只在与当前选中项目不同时才印（sandbox/worktree 会话可能归属别的项目行）。
  // 相同时它是个常量，占了第二行一半宽度却零信息量 —— 侧边栏已经高亮着那个项目了。
  const foreignProject = createMemo(() =>
    props.record.projectName && props.record.projectName !== props.selectedProjectName
      ? props.record.projectName
      : undefined,
  )
  const tint = createMemo(() => messageAgentColor(store.message[props.record.session.id], store.agent))
  // 260710 Red 看板卡片显示会话日期
  const dateLabel = createMemo(() => {
    const ts = props.record.session.time.updated ?? props.record.session.time.created
    const dt = DateTime.fromMillis(ts)
    const now = DateTime.local()
    if (dt.hasSame(now, "day")) return language.t("home.sessions.group.today")
    if (dt.hasSame(now.minus({ days: 1 }), "day")) return language.t("home.sessions.group.yesterday")
    return dt.toFormat("MM-dd")
  })

  return (
    // 260710 Red 看板卡片右键菜单：归档
    <ContextMenu>
      <ContextMenu.Trigger
        as="button"
        type="button"
        data-component="kanban-card"
        class="flex flex-col gap-1.5 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-base px-3 py-2.5 text-left transition-colors duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none cursor-default"
        onClick={props.onClick}
      >
        <div class="flex items-center gap-2 min-w-0 w-full">
          <Show when={props.columnId === "working"}>
            <div class="shrink-0" style={{ color: tint() ?? "var(--icon-interactive-base)" }}>
              <Spinner class="size-[14px]" />
            </div>
          </Show>
          <Show when={props.columnId === "attention"}>
            <div class="size-1.5 shrink-0 rounded-full bg-surface-warning-strong" />
          </Show>
          <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] text-[13px]">
            {title()}
          </span>
          {/* 260823 Red 压缩中徽标：session.time.compacting 非空 = 正按 token 预算在后台压缩，
              TUI 侧边栏同款状态（tui/context/sync.tsx:540），GUI 看板此前毫无指示 */}
          <Show when={props.record.session.time?.compacting}>
            <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-px text-[10px] text-v2-text-text-muted [font-weight:530]">
              {language.t("home.kanban.compacting")}
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-1.5 min-w-0 w-full">
          <Show when={parts().persona}>
            <span class="shrink-0 text-v2-text-text-faint [font-weight:440] text-[11px]">{parts().persona}</span>
          </Show>
          <Show when={foreignProject()}>
            <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440] text-[11px]">
              {foreignProject()}
            </span>
          </Show>
          <span class="ml-auto shrink-0 text-v2-text-text-faint [font-weight:400] text-[10px]">{dateLabel()}</span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          {/* 260814 Red 已归档的卡片给"取消归档"，未归档的给"归档" */}
          <ContextMenu.Item
            onSelect={() => (props.record.session.time?.archived ? props.onUnarchive?.() : props.onArchive())}
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
