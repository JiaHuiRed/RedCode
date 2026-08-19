import { For, Show, createMemo } from "solid-js"
import type { Todo } from "@redcode-ai/sdk/v2/client"
import { Icon } from "@redcode-ai/ui/icon"
import { ScrollView } from "@redcode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"

const emptyTodos: Todo[] = []

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

  const total = createMemo(() => todos().length)
  const done = createMemo(() => todos().filter((t) => t.status === "completed").length)
  const inProgress = createMemo(() => todos().filter((t) => t.status === "in_progress").length)
  const percent = createMemo(() => (total() > 0 ? Math.round((done() / total()) * 100) : 0))

  return (
    <ScrollView class="@container h-full">
      <div class="px-6 pt-4 pb-10 flex flex-col gap-6">
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
