import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ComponentProps, JSXElement, Match, onCleanup, onMount, ParentProps, Show, Switch, createSignal } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

// 261114 Red UX-01 设置窗口可调大小：受控尺寸由消费方持有并持久化（ui 包不依赖
// app 的 persist 基建）。width/height 缺省时回落 data-size 基线；maximized 占满
// 视口（-16px 边距）。opt-in——确认框与选择器保持简洁，只有设置这类管理面板启用。
export interface DialogSize {
  width?: number
  height?: number
  maximized?: boolean
}

export interface DialogProps extends ParentProps {
  title?: JSXElement
  description?: JSXElement
  action?: JSXElement
  size?: "normal" | "large" | "x-large"
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  fit?: boolean
  transition?: boolean
  resizable?: boolean
  /** 受控尺寸：持久化由消费方负责，onResize 回写 */
  dialogSize?: DialogSize
  onResize?: (size: DialogSize) => void
  minWidth?: number
  minHeight?: number
}

const MARGIN = 8 // 容器两侧各留 8px（与 viewport -16px 的既有基线一致）

export function Dialog(props: DialogProps) {
  const i18n = useI18n()
  const minWidth = () => props.minWidth ?? 560
  const minHeight = () => props.minHeight ?? 420

  const [custom, setCustom] = createSignal<DialogSize>(props.dialogSize ?? {})
  const maximized = () => custom().maximized === true
  const hasCustomSize = () => custom().width !== undefined || custom().height !== undefined

  const clampWidth = (width: number) => Math.max(minWidth(), Math.min(width, window.innerWidth - MARGIN * 2))
  const clampHeight = (height: number) => Math.max(minHeight(), Math.min(height, window.innerHeight - MARGIN * 2))

  const apply = (next: DialogSize) => {
    setCustom(next)
    props.onResize?.(next)
  }

  // 主窗口变小时约束到可视区（验收：关闭/保存按钮不越界）。
  onMount(() => {
    const onWindowResize = () => {
      const current = custom()
      if (current.maximized) return
      if (current.width === undefined && current.height === undefined) return
      const width = current.width !== undefined ? clampWidth(current.width) : undefined
      const height = current.height !== undefined ? clampHeight(current.height) : undefined
      if (width !== current.width || height !== current.height) {
        setCustom({ ...current, width, height })
      }
    }
    window.addEventListener("resize", onWindowResize)
    onCleanup(() => window.removeEventListener("resize", onWindowResize))
  })

  const startResize = (event: PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const startWidth = custom().width ?? window.innerWidth - MARGIN * 2
    const startHeight = custom().height ?? window.innerHeight - MARGIN * 2
    const move = (moveEvent: PointerEvent) => {
      apply({
        width: clampWidth(startWidth + (moveEvent.clientX - startX)),
        height: clampHeight(startHeight + (moveEvent.clientY - startY)),
        maximized: false,
      })
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
  }

  const containerStyle = () => {
    if (maximized() || !hasCustomSize()) return undefined
    return {
      width: `${clampWidth(custom().width ?? 0)}px`,
      height: `${clampHeight(custom().height ?? 0)}px`,
    }
  }

  return (
    <div
      data-component="dialog"
      data-fit={props.fit ? true : undefined}
      data-size={props.size || "normal"}
      data-transition={props.transition ? true : undefined}
      data-resizable={props.resizable ? true : undefined}
      data-maximized={maximized() ? true : undefined}
    >
      <div data-slot="dialog-container" style={containerStyle()}>
        <Kobalte.Content
          data-slot="dialog-content"
          data-no-header={!props.title && !props.action && !props.resizable ? "" : undefined}
          classList={{
            ...props.classList,
            [props.class ?? ""]: !!props.class,
          }}
          onOpenAutoFocus={(e) => {
            const target = e.currentTarget as HTMLElement | null
            const autofocusEl = target?.querySelector("[autofocus]") as HTMLElement | null
            if (autofocusEl) {
              e.preventDefault()
              autofocusEl.focus()
            }
          }}
        >
          <Show when={props.title || props.action || props.resizable}>
            <div data-slot="dialog-header">
              <Show when={props.title}>
                <Kobalte.Title data-slot="dialog-title">{props.title}</Kobalte.Title>
              </Show>
              <Show when={!props.title}>
                <span data-slot="dialog-header-spacer" />
              </Show>
              <Show when={props.resizable}>
                <IconButton
                  icon={maximized() ? "restore" : "maximize"}
                  size="normal"
                  variant="ghost"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => apply({ ...custom(), maximized: !maximized() })}
                  aria-label={i18n.t(maximized() ? "ui.common.restore" : "ui.common.maximize")}
                />
              </Show>
              <Switch>
                <Match when={props.action}>{props.action}</Match>
                <Match when={true}>
                  <Kobalte.CloseButton
                    data-slot="dialog-close-button"
                    as={IconButton}
                    icon="close"
                    variant="ghost"
                    aria-label={i18n.t("ui.common.close")}
                  />
                </Match>
              </Switch>
            </div>
          </Show>
          <Show when={props.description}>
            <Kobalte.Description data-slot="dialog-description" style={{ "margin-left": "-4px" }}>
              {props.description}
            </Kobalte.Description>
          </Show>
          <div data-slot="dialog-body">{props.children}</div>
        </Kobalte.Content>
        <Show when={props.resizable}>
          <div data-slot="dialog-resize-handle" onPointerDown={startResize} aria-hidden="true" />
        </Show>
      </div>
    </div>
  )
}
