import { Show, createSignal } from "solid-js"
import { Icon } from "@redcode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { SessionPlanDetails, useSessionPlan } from "./session-plan-tab"

// 261115 Red 计划胶囊：宽桌面折叠态挂在上下文胶囊**下方**的独立卡片。用户意图
// （261115 复审）：「计划」不该塞进上下文胶囊内部——胶囊多数时候不展开，下方大片
// 空白正好给计划单独一个入口；上下堆叠，不在同一列里并列。点击就地展开/收起，
// 不跳 tab；无计划（goal 未设置且无 todo）时整体隐藏。
// 面板展开后入口由顶部 plan tab 接管——本组件只在 compact() 为真时渲染。
export function SessionPlanCapsule() {
  const language = useLanguage()
  const [expanded, setExpanded] = createSignal(false)
  const { goal, total, done, exists } = useSessionPlan()

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
          <Show when={total() > 0}>
            <span class="ml-auto shrink-0 text-11-regular text-text-weaker tabular-nums">
              {done()}/{total()}
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
