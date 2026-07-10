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
import { sessionTitle } from "@/utils/session-title"
import { messageAgentColor } from "@/utils/agent"
import { sessionPermissionRequest } from "@/pages/session/composer/session-request-tree"
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
  openSession: (session: Session) => void
  onArchive: (session: Session) => void
}) {
  const globalSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const language = useLanguage()

  const columns = createMemo((): KanbanColumn[] => {
    const working: KanbanRecord[] = []
    const attention: KanbanRecord[] = []
    const idle: KanbanRecord[] = []

    for (const record of props.records) {
      const [store] = globalSync.child(record.session.directory, { bootstrap: false })
      const id = record.session.id
      const hasPermission = !!sessionPermissionRequest(
        store.session,
        store.permission,
        id,
        (item) => !permission.autoResponds(item, record.session.directory),
      )
      const isWorking = !hasPermission && store.session_working(id)
      const hasUnseen = notification.session.unseenCount(id) > 0
      const hasError = notification.session.unseenHasError(id)

      if (isWorking) {
        working.push(record)
      } else if (hasPermission || hasError || hasUnseen) {
        attention.push(record)
      } else {
        idle.push(record)
      }
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
          <div class="flex flex-col min-w-[220px] flex-1 gap-3">
            <div class="flex items-center gap-2 px-2 h-7 shrink-0">
              <div class="size-2 rounded-full" style={{ "background-color": columnColor(column.id) }} />
              <span class="text-v2-text-text-muted [font-weight:530] text-[13px]">{columnLabel(column.id)}</span>
              <Show when={column.records.length > 0}>
                <span class="text-v2-text-text-faint text-[11px] [font-weight:440]">{column.records.length}</span>
              </Show>
            </div>
            {/* 260710 Red 空闲列会话多时两列网格展示，充分利用右侧空间 */}
            <div class={`overflow-y-auto flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${column.records.length > 6 ? "grid grid-cols-2 gap-2 auto-rows-min content-start" : "flex flex-col gap-2"}`}>
              <Show
                when={column.records.length > 0}
                fallback={
                  <div class="rounded-[8px] border border-dashed border-v2-border-border-base px-3 py-6 text-center text-[12px] text-v2-text-text-faint [font-weight:440]">
                    {language.t("home.kanban.empty")}
                  </div>
                }
              >
                <For each={column.records}>
                  {(record) => (
                    <KanbanCard
                      record={record}
                      columnId={column.id}
                      onClick={() => props.openSession(record.session)}
                      onArchive={() => props.onArchive(record.session)}
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
  onClick: () => void
  onArchive: () => void
}) {
  const globalSync = useServerSync()
  const language = useLanguage()
  const [store] = globalSync.child(props.record.session.directory, { bootstrap: false })
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
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
          <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] text-[13px]">
            {title()}
          </span>
        </div>
        <div class="flex items-center gap-1 min-w-0 w-full">
          <Show when={props.record.projectName}>
            <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440] text-[11px]">
              {props.record.projectName}
            </span>
          </Show>
          <span class="ml-auto shrink-0 text-v2-text-text-faint [font-weight:400] text-[10px]">
            {dateLabel()}
          </span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={props.onArchive}>
            <ContextMenu.ItemLabel>{language.t("command.session.archive")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}
