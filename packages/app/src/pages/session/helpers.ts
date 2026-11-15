import { batch, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"

// 261024 Red 层级归位：createSessionTabs / useSessionLayout 搬到 @/context/session-layout
// （tabs 状态模型与 SYSTEM_TABS 的 owner 在 context/layout，且被 components/ 消费），
// focusTerminalById / shouldFocusTerminalOnKeyDown 搬到 @/utils/terminal-focus。
// 本文件只剩 pages/session 内部消费的打开文件/尺寸胶水，不再被 components/ 反向依赖。

export const createOpenReviewFile = (input: {
  showAllFiles: () => void
  tabForPath: (path: string) => string
  openTab: (tab: string) => void
  setActive: (tab: string) => void
  loadFile: (path: string) => any | Promise<void>
  // 261115 Red UX-18 预览槽位：一次性浏览共用一个可替换标签，连看多个文件不堆标签。
  closeTab?: (tab: string) => void
  previewTab?: () => string | undefined
  setPreviewTab?: (tab: string | undefined) => void
}) => {
  return (path: string) => {
    batch(() => {
      input.showAllFiles()
      const tab = input.tabForPath(path)
      // 上一槽位还开着且不是本次目标 → 顶掉；已关闭（或用户固定后清了标记）则不补刀。
      const prev = input.previewTab?.()
      if (prev && prev !== tab) input.closeTab?.(prev)
      input.setPreviewTab?.(tab)
      // 立即开标签：点文件的下一次绘制就能看到目标标签与读取状态，加载期由
      // FileTabContent 自带的 Loading 态接住——不再「先加载后开标签」让人感觉没点上。
      input.openTab(tab)
      input.setActive(tab)
      void input.loadFile(path)
    })
  }
}

export const createOpenSessionFileTab = (input: {
  normalizeTab: (tab: string) => string
  openTab: (tab: string) => void
  pathFromTab: (tab: string) => string | undefined
  loadFile: (path: string) => void
  openReviewPanel: () => void
  setActive: (tab: string) => void
  // 261115 Red UX-18：普通打开（文件树）若命中当前预览槽位，等于用户把它当常驻
  // 标签用——清掉预览标记，之后的一次性打开不会再顶掉它。
  setPreviewTab?: (tab: string | undefined) => void
  previewTab?: () => string | undefined
}) => {
  return (value: string) => {
    const next = input.normalizeTab(value)
    input.openTab(next)

    const path = input.pathFromTab(next)
    if (!path) return

    if (input.previewTab?.() === next) input.setPreviewTab?.(undefined)
    input.loadFile(path)
    input.openReviewPanel()
    input.setActive(next)
  }
}

export const getTabReorderIndex = (tabs: readonly string[], from: string, to: string) => {
  const fromIndex = tabs.indexOf(from)
  const toIndex = tabs.indexOf(to)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return undefined
  return toIndex
}

export const createSizing = () => {
  const [state, setState] = createStore({ active: false })
  let t: number | undefined

  const stop = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", false)
  }

  const start = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", true)
  }

  onMount(() => {
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
  })

  onCleanup(() => {
    if (t !== undefined) clearTimeout(t)
  })

  return {
    active: () => state.active,
    start,
    touch() {
      start()
      t = window.setTimeout(stop, 120)
    },
  }
}

export type Sizing = ReturnType<typeof createSizing>
