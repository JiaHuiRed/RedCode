import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, Show } from "solid-js"
import { compact } from "./context"

const id = "internal:sidebar-goal"

// 260820 cc Goal 一直是「后端整套在跑、前端一个字都没有」：goal.ts 有独立表与五态状态机，
// prompt.ts 每轮把 `▸ ACTIVE GOAL` 注进系统提示，goal-continuation.ts 按 token 预算自动
// 续跑，goal_set/goal_done/goal_clear 三个工具还是无 flag 门控的默认工具——唯独没有任何
// 界面。于是模型钉了什么目标、烧了多少预算、是不是已经 blocked，用户全看不见。
//
// 260801 Red 起的默认预算，与 goal-continuation.ts 的 DEFAULT_TOKEN_BUDGET 同源。
// 那边是行为的权威，这里只是显示；两处不同步的后果是进度条画错，不会影响续跑。
const DEFAULT_TOKEN_BUDGET = 200_000
const MAX_GOAL_TURNS = 20

const STATUS_COLOR: Record<string, string> = {
  active: "#66bb6a",
  done: "#4dd0e1",
  blocked: "#ff5252",
  budget_limited: "#ff9100",
  cleared: "#9e9e9e",
}

const STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  done: "已完成",
  blocked: "受阻",
  budget_limited: "预算用尽",
  cleared: "已清除",
}

const BAR_WIDTH = 20
export function budgetBar(used: number, budget: number): { filled: string; rest: string } {
  if (budget <= 0) return { filled: "", rest: "░".repeat(BAR_WIDTH) }
  const ratio = Math.max(0, Math.min(1, used / budget))
  const filled = Math.min(BAR_WIDTH, Math.round(ratio * BAR_WIDTH))
  return { filled: "█".repeat(filled), rest: "░".repeat(BAR_WIDTH - filled) }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const goal = createMemo(() => props.api.state.session.goal(props.session_id))
  // cleared 不显示：目标被清掉之后这块就该消失，留一行「已清除」只是占地方。
  const show = createMemo(() => {
    const item = goal()
    return !!item && item.status !== "cleared" && item.text.trim().length > 0
  })

  // 轮次上限与预算天花板只在自动续跑开启时才真的会拦人（goal-continuation.ts 的三闸门），
  // 默认是关的。关着还画一条「3/20 轮」的进度会让人以为有个并不存在的限制在逼近。
  // tokens_used 与之无关——它在每轮 runLoop 结束时无条件累加（prompt.ts:1924），
  // 任何时候都是「这个目标到目前为止烧了多少」，所以恒显示。
  const autoContinue = createMemo(() => props.api.state.config.experimental?.goal_auto_continue === true)
  const budget = createMemo(() => props.api.state.config.experimental?.goal_token_budget ?? DEFAULT_TOKEN_BUDGET)

  return (
    <Show when={show()}>
      {(_) => {
        const item = () => goal()!
        return (
          <box
            border={["top"]}
            borderColor={theme().borderSubtle ?? theme().textMuted}
            title={` Goal · ${STATUS_LABEL[item().status] ?? item().status} `}
            titleAlignment="left"
            paddingTop={0}
          >
            <text fg={STATUS_COLOR[item().status] ?? theme().text}>{item().text}</text>
            <Show
              when={autoContinue()}
              fallback={
                <text fg={theme().textMuted}>
                  已用 <span style={{ fg: theme().text }}>{compact(item().tokens_used)}</span> tokens
                </text>
              }
            >
              <text fg={theme().textMuted}>
                <span style={{ fg: theme().text }}>{compact(item().tokens_used)}</span> / {compact(budget())} · 第{" "}
                {item().turn_count}/{MAX_GOAL_TURNS} 轮
              </text>
              <text>
                <span style={{ fg: STATUS_COLOR[item().status] ?? theme().text }}>
                  {budgetBar(item().tokens_used, budget()).filled}
                </span>
                <span style={{ fg: theme().textMuted }}>{budgetBar(item().tokens_used, budget()).rest}</span>
              </text>
            </Show>
          </box>
        )
      }}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // 350：夹在 lsp(300) 与 todo(400) 之间。挨着 Todo 是刻意的——goal_set 的工具说明里
    // 写着「Sub-tasks become todos」，两块本来就是一件事的两个层级。
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
