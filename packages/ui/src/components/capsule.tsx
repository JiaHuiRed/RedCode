import { Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon, type IconProps } from "./icon"

/** 状态点语义。色值映射在 capsule.css，调用方只给语义、不写颜色。 */
export type CapsuleTone = "success" | "warning" | "critical" | "idle"

// 让掉原生 div 的 `title`（HTML 属性是 string）：这里要的是可放 JSX 的分组标题。
export interface CapsuleProps extends Omit<ComponentProps<"div">, "title"> {
  /**
   * - `floating`：浮层里的独立卡片。实底色 + 描边投影，与 dialog/popover 共用同一条 shadow token
   * - `inline`：嵌在侧栏/面板里的分组卡。浅表面，分组靠标题行区分
   */
  attach?: "floating" | "inline"
  /** 分组标题行；`title`/`icon`/`action` 都没有时不渲染这一行。 */
  title?: JSX.Element
  icon?: IconProps["name"]
  /** 标题右侧动作槽（如「+」）。 */
  action?: JSX.Element
}

export interface CapsuleRowProps extends ComponentProps<"div"> {
  icon?: IconProps["name"]
  /** 左侧状态点；给了 `status` 就不渲染 `icon`。 */
  status?: CapsuleTone
  /** 主体标签。给了 `children` 时由 children 充当主体，本项不渲染。 */
  label?: JSX.Element
  description?: JSX.Element
  /** 右侧内容槽：数值、徽标、开关等。 */
  trailing?: JSX.Element
  /** 右侧展开箭头。 */
  chevron?: boolean
  selected?: boolean
  disabled?: boolean
}

export function Capsule(props: CapsuleProps) {
  const [split, rest] = splitProps(props, ["attach", "title", "icon", "action", "class", "classList", "children"])
  const heading = () => split.title !== undefined || split.icon !== undefined || split.action !== undefined
  return (
    <div
      {...rest}
      data-component="capsule"
      data-attach={split.attach ?? "floating"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Show when={heading()}>
        <div data-slot="capsule-header">
          <Show when={split.icon}>{(name) => <Icon name={name()} size="small" />}</Show>
          <span data-slot="capsule-title">{split.title}</span>
          <Show when={split.action}>
            <div data-slot="capsule-action">{split.action}</div>
          </Show>
        </div>
      </Show>
      {split.children}
    </div>
  )
}

export function CapsuleRow(props: CapsuleRowProps) {
  const [split, rest] = splitProps(props, [
    "icon",
    "status",
    "label",
    "description",
    "trailing",
    "chevron",
    "selected",
    "disabled",
    "class",
    "classList",
    "children",
    "onClick",
  ])
  // 只有「有 onClick 且未 disabled」才渲染成 button。disabled 的行退回 div：语义上天然不可交互，
  // 也就不必给 div 塞一个无效的 disabled 属性（<button> 里再塞 Switch 会让嵌套 button 更麻烦）。
  const actionable = () => typeof split.onClick === "function" && !split.disabled
  return (
    <Dynamic
      component={actionable() ? "button" : "div"}
      {...rest}
      type={actionable() ? "button" : undefined}
      data-component="capsule-row"
      data-tone={split.status}
      data-interactive={actionable() ? "" : undefined}
      data-selected={split.selected ? "" : undefined}
      data-disabled={split.disabled ? "" : undefined}
      onClick={actionable() ? split.onClick : undefined}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Show when={split.status}>
        <span data-slot="capsule-row-dot" aria-hidden="true" />
      </Show>
      <Show when={split.status ? undefined : split.icon}>
        {(name) => (
          <span data-slot="capsule-row-icon">
            <Icon name={name()} size="small" />
          </span>
        )}
      </Show>
      <Show
        when={split.children !== undefined}
        fallback={
          <span data-slot="capsule-row-main">
            <span data-slot="capsule-row-label">{split.label}</span>
            <Show when={split.description}>
              <span data-slot="capsule-row-description">{split.description}</span>
            </Show>
          </span>
        }
      >
        <span data-slot="capsule-row-body">{split.children}</span>
      </Show>
      <Show when={split.trailing}>
        <span data-slot="capsule-row-trailing">{split.trailing}</span>
      </Show>
      <Show when={split.chevron}>
        <span data-slot="capsule-row-chevron">
          <Icon name="chevron-down" size="small" />
        </span>
      </Show>
    </Dynamic>
  )
}
