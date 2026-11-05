import { Show, type JSX } from "solid-js"
import { DockTray } from "@redcode-ai/ui/dock-surface"
import { Icon } from "@redcode-ai/ui/icon"

/**
 * 261106 Red 抽取 followup/revert 两个 composer dock 的可折叠外壳。
 * 头部的 collapse 状态接线 + 键盘可达按钮（Enter/Space 切换）+ 折叠占位/展开容器
 * 此前逐字重复两份（session-followup-dock / session-revert-dock），改键盘行为要记得
 * 改两处——正是「数兄弟」红线点名的形态。字号差异（13/14）由 props 保留，视觉零变化。
 * 261106 Red 头部从 div[role=button]+内嵌 IconButton 改为单个原生 button：
 * 原结构是交互控件嵌交互控件（audit P2-03），原生 button 自带 Enter/Space 语义，
 * aria-expanded 暴露展开态，chevron 降级为纯视觉图标（aria-hidden）；
 * 可访问名由按钮内容（标题+摘要）承担，ariaKeyPrefix/.expand/.collapse 不再需要。
 */
export function CollapsibleDock(props: {
  dataComponent: string
  label: string
  preview: string
  collapsed: boolean
  onToggle: () => void
  labelClass: string
  previewClass: string
  trayStyle?: JSX.CSSProperties
  children: JSX.Element
}) {
  const toggle = props.onToggle
  const contentId = `${props.dataComponent}-content`
  return (
    <DockTray data-component={props.dataComponent} style={props.trayStyle}>
      <button
        type="button"
        class="pl-3 pr-2 py-2 flex items-center gap-2 text-left w-full cursor-default"
        aria-expanded={!props.collapsed}
        // 261106 Red 审计 P3：内容区只在展开时挂载，折叠态下 aria-controls 指向
        // 不存在的元素——目标缺席时不再声明该属性
        aria-controls={props.collapsed ? undefined : contentId}
        onClick={toggle}
        // 与原 IconButton 的 mousedown 行为一致：点击不打走编辑器焦点
        onMouseDown={(event) => event.preventDefault()}
      >
        <span class={`shrink-0 ${props.labelClass} text-text-strong`}>{props.label}</span>
        <Show when={props.collapsed && props.preview}>
          <span class={`min-w-0 flex-1 truncate ${props.previewClass} text-text-base`}>{props.preview}</span>
        </Show>
        <span
          class="ml-auto shrink-0"
          data-collapsed={props.collapsed ? "true" : "false"}
          aria-hidden="true"
          style={{ transform: `rotate(${props.collapsed ? 180 : 0}deg)` }}
        >
          <Icon name="chevron-down" size="small" />
        </span>
      </button>

      <Show when={props.collapsed}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={!props.collapsed}>
        <div id={contentId} class="px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
          {props.children}
        </div>
      </Show>
    </DockTray>
  )
}
