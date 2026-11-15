import { useParams } from "@solidjs/router"
import { createMemo, type Accessor } from "solid-js"
import { SYSTEM_TABS, useLayout } from "@/context/layout"
import { same } from "@/utils/same"

// 261024 Red 从 pages/session/session-layout.ts 上移：useSessionLayout 是 layout context
// 的会话侧视图，却被 7 个 components/ 文件反向 import（components → pages 违规）。
// context/ 才是它的层。createSessionTabs 同批搬入——它消费的 SYSTEM_TABS/tabs 状态模型
// 都在 context/layout，且被 prompt-input / dialog-select-file 两个组件消费。

export const useSessionKey = () => {
  const params = useParams()
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  return { params, sessionKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey } = useSessionKey()
  return {
    params,
    sessionKey,
    tabs: createMemo(() => layout.tabs(sessionKey)),
    view: createMemo(() => layout.view(sessionKey)),
  }
}

const emptyTabs: string[] = []

type Tabs = {
  active: Accessor<string | undefined>
  all: Accessor<string[]>
}

type TabsInput = {
  tabs: Accessor<Tabs>
  pathFromTab: (tab: string) => string | undefined
  normalizeTab: (tab: string) => string
  review?: Accessor<boolean>
  hasReview?: Accessor<boolean>
}

// 260923 Red C2：固定 system tabs（review/context/outline/plan/status）永远存在、不需要 open
// 才出现、不可关闭、不参与排序、不进 openedTabs。此前 createSessionTabs 的特殊标签过滤散落
// 着 context/review/status/plan 四个字符串，漏了 outline——outline 于是被当成文件标签：既进
// SortableProvider 的文件列表（可拖拽、可关闭），又有一个写死的 Tabs.Trigger，同一个标签在
// strip 上出现两份。C2 起统一走 SYSTEM_TABS；C4 起定义与 close 守卫都在 layout（tabs 状态
// 模型的 owner），这里 re-export 保持既有调用面。
export const createSessionTabs = (input: TabsInput) => {
  const review = input.review ?? (() => false)
  const hasReview = input.hasReview ?? (() => false)
  const contextOpen = createMemo(() => input.tabs().active() === "context" || input.tabs().all().includes("context"))
  const openedTabs = createMemo(
    () => {
      const seen = new Set<string>()
      return input
        .tabs()
        .all()
        .flatMap((tab) => {
          // 260923 Red C2 统一走 SYSTEM_TABS（含 outline，此前漏网会被当成文件标签）
          if (SYSTEM_TABS.has(tab)) return []
          const value = input.pathFromTab(tab) ? input.normalizeTab(tab) : tab
          if (seen.has(value)) return []
          seen.add(value)
          return [value]
        })
    },
    emptyTabs,
    { equals: same },
  )
  const fallbackTab = () => {
    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (review() && hasReview()) return "review"
    return "empty"
  }
  const activeTab = createMemo(() => {
    const active = input.tabs().active()
    if (active === "context") return active
    if (active === "review" && review()) return active
    if (active === "status") return active
    if (active && input.pathFromTab(active)) return input.normalizeTab(active)
    if (active && active !== "review") return active

    return fallbackTab()
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })
  // 260923 Red C4：五项固定 system tab 不可关闭（此前 context 是唯一例外——它一旦被
  // close 就从 all[] 里消失，入口跟着没）。active 落在 system tab 上时这里返回 undefined，
  // tab.close 命令与 SortableTab 的关闭按钮随之无操作。
  const closableTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })

  return {
    contextOpen,
    openedTabs,
    activeTab,
    activeFileTab,
    closableTab,
  }
}
