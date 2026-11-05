import { Show, type JSX } from "solid-js"
import { DockTray } from "@redcode-ai/ui/dock-surface"
import { IconButton } from "@redcode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

/**
 * 261106 Red 抽取 followup/revert 两个 composer dock 的可折叠外壳。
 * 头部的 collapse 状态接线 + 键盘可达按钮（Enter/Space 切换）+ 折叠占位/展开容器
 * 此前逐字重复两份（session-followup-dock / session-revert-dock），改键盘行为要记得
 * 改两处——正是「数兄弟」红线点名的形态。字号差异（13/14）由 props 保留，视觉零变化。
 */
export function CollapsibleDock(props: {
  dataComponent: string
  label: string
  preview: string
  collapsed: boolean
  onToggle: () => void
  /** aria-label 的 i18n key 前缀，如 "session.followupDock" → .expand / .collapse */
  ariaKeyPrefix: string
  labelClass: string
  previewClass: string
  trayStyle?: JSX.CSSProperties
  children: JSX.Element
}) {
  const language = useLanguage()
  const toggle = props.onToggle
  return (
    <DockTray data-component={props.dataComponent} style={props.trayStyle}>
      <div
        class="pl-3 pr-2 py-2 flex items-center gap-2"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggle()
        }}
      >
        <span class={`shrink-0 ${props.labelClass} text-text-strong cursor-default`}>{props.label}</span>
        <Show when={props.collapsed && props.preview}>
          <span class={`min-w-0 flex-1 truncate ${props.previewClass} text-text-base cursor-default`}>
            {props.preview}
          </span>
        </Show>
        <div class="ml-auto shrink-0">
          <IconButton
            data-collapsed={props.collapsed ? "true" : "false"}
            icon="chevron-down"
            size="normal"
            variant="ghost"
            style={{ transform: `rotate(${props.collapsed ? 180 : 0}deg)` }}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            aria-label={
              props.collapsed
                ? language.t(`${props.ariaKeyPrefix}.expand`)
                : language.t(`${props.ariaKeyPrefix}.collapse`)
            }
          />
        </div>
      </div>

      <Show when={props.collapsed}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={!props.collapsed}>
        <div class="px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">{props.children}</div>
      </Show>
    </DockTray>
  )
}
