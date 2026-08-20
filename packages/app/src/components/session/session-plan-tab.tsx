import { For, Show, createMemo } from "solid-js"
import type { Goal, Todo } from "@redcode-ai/sdk/v2/client"
import { Icon } from "@redcode-ai/ui/icon"
import { ScrollView } from "@redcode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"

const emptyTodos: Todo[] = []

// 260820 cc Goal 一直是「后端整套在跑、前端一个字都没有」：goal.ts 有独立表与五态状态机，
// prompt.ts 每轮把 `▸ ACTIVE GOAL` 注进系统提示，goal-continuation.ts 按 token 预算自动
// 续跑，goal_set/goal_done/goal_clear 还是无 flag 门控的默认工具——唯独没有任何界面。
//
// 放在 Plan 面板顶部而不是单开一处：goal_set 的工具说明里写着「Sub-tasks become todos」，
// 目标与待办本来就是同一件事的两个层级，TUI 侧边栏也是这个顺序（goal 350 / todo 400）。
//
// 与 goal-continuation.ts 的 DEFAULT_TOKEN_BUDGET 同源。那边是行为的权威，这里只是显示。
const DEFAULT_TOKEN_BUDGET = 200_000
const MAX_GOAL_TURNS = 20

function goalColor(status: Goal["status"]) {
  if (status === "active") return "var(--syntax-success)"
  if (status === "done") return "var(--syntax-info)"
  if (status === "blocked") return "var(--syntax-critical)"
  if (status === "budget_limited") return "var(--syntax-warning)"
  return "var(--text-weaker)"
}

function statusColor(status: string) {
  if (status === "completed") return "var(--syntax-success)"
  if (status === "in_progress") return "var(--syntax-info)"
  if (status === "cancelled") return "var(--text-weaker)"
  return "var(--text-weak)"
}

// 260615 Red Plan 面板：侧栏标签页，展示当前会话的完整 todo 计划进度
export function SessionPlanTab() {
  const sync = useSync()
  const language = useLanguage()
  const { params } = useSessionLayout()

  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return emptyTodos
    return (sync.data.todo[id] as Todo[] | undefined) ?? emptyTodos
  })

  // cleared 不显示：目标被清掉之后这块就该消失，留一行「已清除」只是占地方。
  const goal = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    const pinned = sync.data.goal[id]
    if (!pinned || pinned.status === "cleared" || !pinned.text.trim()) return undefined
    return pinned
  })

  // 轮次上限与预算天花板只在自动续跑开启时才真的会拦人（goal-continuation.ts 的三闸门），
  // 默认是关的。关着还画一条「3/20 轮」的进度会让人以为有个并不存在的限制在逼近。
  // tokens_used 与之无关——它在每轮 runLoop 结束时无条件累加（prompt.ts:1924），恒显示。
  const autoContinue = createMemo(() => sync.data.config.experimental?.goal_auto_continue === true)
  const goalBudget = createMemo(() => sync.data.config.experimental?.goal_token_budget ?? DEFAULT_TOKEN_BUDGET)
  const goalPercent = createMemo(() => {
    const pinned = goal()
    const budget = goalBudget()
    if (!pinned || budget <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((pinned.tokens_used / budget) * 100)))
  })

  const total = createMemo(() => todos().length)
  const done = createMemo(() => todos().filter((t) => t.status === "completed").length)
  const inProgress = createMemo(() => todos().filter((t) => t.status === "in_progress").length)
  const percent = createMemo(() => (total() > 0 ? Math.round((done() / total()) * 100) : 0))

  return (
    <ScrollView class="@container h-full">
      <div class="px-6 pt-4 pb-10 flex flex-col gap-6">
        <Show when={goal()}>
          {(pinned) => (
            <div class="flex flex-col gap-2 border border-border-base rounded-md bg-surface-base px-3 py-2">
              <div class="flex items-center justify-between gap-2">
                <div class="text-12-regular text-text-weak">{language.t("session.goal.title")}</div>
                <div class="text-11-regular" style={{ color: goalColor(pinned().status) }}>
                  {language.t(`session.goal.status.${pinned().status}` as Parameters<typeof language.t>[0])}
                </div>
              </div>
              <div class="text-13-regular text-text-strong select-text">{pinned().text}</div>
              <Show
                when={autoContinue()}
                fallback={
                  <div class="text-11-regular text-text-weaker">
                    {language.t("session.goal.used", { tokens: pinned().tokens_used.toLocaleString(language.intl()) })}
                  </div>
                }
              >
                <div class="text-11-regular text-text-weaker">
                  {language.t("session.goal.budget", {
                    used: pinned().tokens_used.toLocaleString(language.intl()),
                    budget: goalBudget().toLocaleString(language.intl()),
                    turn: pinned().turn_count,
                    max: MAX_GOAL_TURNS,
                  })}
                </div>
                <div class="h-1.5 w-full rounded-full bg-surface-raised overflow-hidden flex">
                  <div
                    class="h-full rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${goalPercent()}%`, "background-color": goalColor(pinned().status) }}
                  />
                </div>
              </Show>
            </div>
          )}
        </Show>
        <Show
          when={total() > 0}
          fallback={
            <div class="flex flex-col items-center justify-center text-center gap-3 py-16">
              <Icon name="checklist" size="large" class="text-text-weaker opacity-40" />
              <div class="text-13-regular text-text-weak">{language.t("session.plan.empty")}</div>
            </div>
          }
        >
          {/* Progress header */}
          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <div class="text-14-medium text-text-strong">
                {language.t("session.plan.progress", { done: done(), total: total() })}
              </div>
              <div class="text-12-regular text-text-weak">{percent()}%</div>
            </div>
            <div class="h-1.5 w-full rounded-full bg-surface-base overflow-hidden flex">
              <div
                class="h-full rounded-full transition-all duration-300 ease-out"
                style={{
                  width: `${percent()}%`,
                  "background-color": percent() === 100 ? "var(--syntax-success)" : "var(--syntax-info)",
                }}
              />
            </div>
            <div class="flex gap-3 text-11-regular text-text-weak">
              <Show when={inProgress() > 0}>
                <div class="flex items-center gap-1">
                  <div class="size-2 rounded-sm" style={{ "background-color": "var(--syntax-info)" }} />
                  <span>
                    {inProgress()} {language.t("session.plan.inProgress")}
                  </span>
                </div>
              </Show>
              <Show when={done() > 0}>
                <div class="flex items-center gap-1">
                  <div class="size-2 rounded-sm" style={{ "background-color": "var(--syntax-success)" }} />
                  <span>
                    {done()} {language.t("session.plan.done")}
                  </span>
                </div>
              </Show>
              <Show when={total() - done() - inProgress() > 0}>
                <div class="flex items-center gap-1">
                  <div class="size-2 rounded-sm" style={{ "background-color": "var(--text-weak)" }} />
                  <span>
                    {total() - done() - inProgress()} {language.t("session.plan.pending")}
                  </span>
                </div>
              </Show>
            </div>
          </div>

          {/* Todo list */}
          <div class="flex flex-col gap-1">
            <For each={todos()}>
              {(todo, index) => (
                <div
                  class="flex items-start gap-3 px-3 py-2.5 rounded-md"
                  classList={{
                    "bg-surface-base": todo.status === "in_progress",
                  }}
                >
                  <div class="shrink-0 mt-0.5 flex items-center justify-center size-5">
                    <Show
                      when={todo.status !== "in_progress"}
                      fallback={
                        <svg
                          viewBox="0 0 12 12"
                          width="12"
                          height="12"
                          fill="currentColor"
                          xmlns="http://www.w3.org/2000/svg"
                          class="block"
                          style={{ color: statusColor(todo.status) }}
                        >
                          <circle
                            cx="6"
                            cy="6"
                            r="3"
                            style={{
                              animation: "var(--animate-pulse-scale)",
                              "transform-origin": "center",
                              "transform-box": "fill-box",
                            }}
                          />
                        </svg>
                      }
                    >
                      <Show
                        when={todo.status === "completed"}
                        fallback={
                          <div
                            class="size-2.5 rounded-full border-2"
                            style={{ "border-color": statusColor(todo.status) }}
                          />
                        }
                      >
                        <svg
                          viewBox="0 0 16 16"
                          width="16"
                          height="16"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          style={{ color: statusColor(todo.status) }}
                        >
                          <path
                            d="M3.5 8.5L6.5 11.5L12.5 4.5"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </Show>
                    </Show>
                  </div>
                  <div class="min-w-0 flex-1">
                    <div
                      class="text-13-regular break-words"
                      style={{
                        color:
                          todo.status === "completed" || todo.status === "cancelled"
                            ? "var(--text-weak)"
                            : todo.status === "in_progress"
                              ? "var(--text-strong)"
                              : "var(--text-base)",
                        "text-decoration":
                          todo.status === "completed" || todo.status === "cancelled" ? "line-through" : "none",
                        "text-decoration-color": "var(--text-weaker)",
                      }}
                    >
                      {todo.content}
                    </div>
                  </div>
                  <div class="shrink-0 text-11-regular text-text-weaker mt-0.5">{index() + 1}</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </ScrollView>
  )
}
