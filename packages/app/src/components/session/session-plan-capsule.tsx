import { Show, createMemo, createSignal } from "solid-js"
import type { Goal, Todo } from "@redcode-ai/sdk/v2/client"
import { Icon } from "@redcode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/context/session-layout"
import { SessionPlanDetails } from "./session-plan-tab"

const emptyTodos: Todo[] = []

// 261115 Red 计划胶囊：宽桌面折叠态挂在上下文胶囊**下方**的独立卡片。用户意图
// （261115 复审）：「计划」不该塞进上下文胶囊内部——胶囊多数时候不展开，下方大片
// 空白正好给计划单独一个入口；上下堆叠，不在同一列里并列。点击就地展开/收起，
// 不跳 tab；无计划（goal 未设置且无 todo）时整体隐藏。
export function SessionPlanCapsule() {
  const sync = useSync()
  const language = useLanguage()
  const { params } = useSessionLayout()
  const [expanded, setExpanded] = createSignal(false)

  // goal 过滤与 SessionPlanDetails 同源：cleared 不显示。
  const goal = createMemo((): Goal | undefined => {
    const id = params.id
    if (!id) return undefined
    const pinned = sync.data.goal[id]
    if (!pinned || pinned.status === "cleared" || !pinned.text.trim()) return undefined
    return pinned
  })
  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return emptyTodos
    return (sync.data.todo[id] as Todo[] | undefined) ?? emptyTodos
  })
  const exists = createMemo(() => !!goal() || todos().length > 0)
  const done = createMemo(() => todos().filter((todo) => todo.status === "completed").length)

  return (
    <Show when={exists()}>
      <div data-component="session-plan-capsule" class="session-side-panel__plan-capsule">
        <button
          type="button"
          data-action="plan-capsule"
          class="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
          aria-expanded={expanded()}
          aria-label={language.t("session.tab.plan")}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name="checklist" size="small" class="shrink-0 text-text-weak" />
          <span class="shrink-0 text-11-regular text-text-weak">{language.t("session.tab.plan")}</span>
          <Show when={goal()}>
            {(pinned) => (
              <span class="min-w-0 flex-1 truncate text-12-regular text-text-base select-text">{pinned().text}</span>
            )}
          </Show>
          <Show when={todos().length > 0}>
            <span class="ml-auto shrink-0 text-11-regular text-text-weaker tabular-nums">
              {done()}/{todos().length}
            </span>
          </Show>
          <Icon
            name="chevron-down"
            size="small"
            class={
              expanded()
                ? "shrink-0 rotate-180 text-text-weak transition-transform"
                : "shrink-0 text-text-weak transition-transform"
            }
          />
        </button>
        <Show when={expanded()}>
          <div class="min-h-0 overflow-y-auto px-3 pb-3">
            <SessionPlanDetails />
          </div>
        </Show>
      </div>
    </Show>
  )
}
