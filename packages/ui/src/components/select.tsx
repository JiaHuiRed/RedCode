import { Select as Kobalte } from "@kobalte/core/select"
import { createMemo, onCleanup, splitProps, type ComponentProps, type JSX } from "solid-js"
import { pipe, groupBy, entries, map } from "remeda"
import { Button, ButtonProps } from "./button"
import { Icon } from "./icon"

export type SelectProps<T> = Omit<ComponentProps<typeof Kobalte<T>>, "value" | "onSelect" | "children"> & {
  placeholder?: string
  options: T[]
  current?: T
  value?: (x: T) => string
  label?: (x: T) => string
  groupBy?: (x: T) => string
  valueClass?: ComponentProps<"div">["class"]
  onSelect?: (value: T | undefined) => void
  onHighlight?: (value: T | undefined) => (() => void) | void
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  children?: (item: T | undefined) => JSX.Element
  triggerStyle?: JSX.CSSProperties
  triggerVariant?: "settings"
  triggerProps?: Record<string, string | number | boolean | undefined>
}

/** 分组子项的私有键名——不能用业务数据里可能存在的名字（见 grouped() 注释） */
const GROUP_CHILDREN = "__selectGroupItems"
type SelectGroup<T> = { category: string; __selectGroupItems: T[] }

export function Select<T>(props: SelectProps<T> & Omit<ButtonProps, "children">) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "placeholder",
    "options",
    "current",
    "value",
    "label",
    "groupBy",
    "valueClass",
    "onSelect",
    "onHighlight",
    "onOpenChange",
    "children",
    "triggerStyle",
    "triggerVariant",
    "triggerProps",
  ])

  const state = {
    key: undefined as string | undefined,
    cleanup: undefined as (() => void) | void,
  }

  const stop = () => {
    state.cleanup?.()
    state.cleanup = undefined
    state.key = undefined
  }

  const keyFor = (item: T) => (local.value ? local.value(item) : (item as string))

  const move = (item: T | undefined) => {
    if (!local.onHighlight) return
    if (!item) {
      stop()
      return
    }

    const key = keyFor(item)
    if (state.key === key) return
    state.cleanup?.()
    state.cleanup = local.onHighlight(item)
    state.key = key
  }

  onCleanup(stop)

  // 260808 Red: 分组子项的键名必须是**选项数据里不可能出现的**名字。
  // 原来叫 `options`，而 agent 选项对象自带 `options` 字段（`/agent` 返回的
  // name/displayName/description/mode/native/permission/**options**）——Kobalte 按
  // `optionGroupChildren` 逐项探测，于是把每个 agent 当成"分组"、去它的 `options`
  // 里找子项，那是个对象不是数组，结果一个叶子都没有：agent 下拉打开永远是空的。
  // 推理强度下拉是字符串选项、不带这个字段，所以只坏了 agent 那一个——两个控件
  // 症状不同的根源就在这。改成带前缀的私有键，任何业务字段都不会撞上。
  const grouped = createMemo(() => {
    const result = pipe(
      local.options,
      groupBy((x) => (local.groupBy ? local.groupBy(x) : "")),
      entries(),
      map(([k, v]) => ({ category: k, [GROUP_CHILDREN]: v })),
    )
    return result
  })

  return (
    // @ts-ignore
    <Kobalte<T, SelectGroup<T>>
      {...others}
      data-component="select"
      data-trigger-style={local.triggerVariant}
      placement={local.triggerVariant === "settings" ? "bottom-end" : "bottom-start"}
      gutter={4}
      // 260807 Red: Kobalte Select 的 value 契约是 Option[]（index-30251fee.d.ts:79），
      // 传单个值会在打开下拉时 selectedKeys 求值 .map 崩 → 下拉渲染空。
      // 包成数组修复；onChange 侧同样收到数组，取 [0] 还原单值语义（见 onChange）。
      value={local.current}
      options={grouped()}
      optionValue={(x) => (local.value ? local.value(x) : (x as string))}
      optionTextValue={(x) => (local.label ? local.label(x) : (x as string))}
      optionGroupChildren={GROUP_CHILDREN}
      placeholder={local.placeholder}
      sectionComponent={(local) => (
        <Kobalte.Section data-slot="select-section">{local.section.rawValue.category}</Kobalte.Section>
      )}
      itemComponent={(itemProps) => (
        <Kobalte.Item
          {...itemProps}
          data-slot="select-select-item"
          classList={{
            ...local.classList,
            [local.class ?? ""]: !!local.class,
          }}
          onPointerEnter={() => move(itemProps.item.rawValue)}
          onPointerMove={() => move(itemProps.item.rawValue)}
          onFocus={() => move(itemProps.item.rawValue)}
        >
          <Kobalte.ItemLabel data-slot="select-select-item-label">
            {local.children
              ? local.children(itemProps.item.rawValue)
              : local.label
                ? local.label(itemProps.item.rawValue)
                : (itemProps.item.rawValue as string)}
          </Kobalte.ItemLabel>
          <Kobalte.ItemIndicator data-slot="select-select-item-indicator">
            <Icon name="check-small" size="small" />
          </Kobalte.ItemIndicator>
        </Kobalte.Item>
      )}
      onChange={(v) => {
        // 260808 Red: Kobalte 的进出契约**不对称**，两侧必须分别处理：
        //   - value 进去要数组：selectedKeys 无条件 `.map()`（chunk/7ZVQULJJ.js:285-290），
        //     传单值会在打开下拉时崩、下拉渲染空（260807 已修，见上面 value=）。
        //   - onChange 出来是**单值**：实测 `onChange raw = low, typeof = string`。
        // 260807 那次把两侧都按数组处理，于是 `v?.[0]` 对字符串取到首字符——"low" → "l"，
        // 永远匹配不上任何选项，表现为「点了没反应 / 选完跳回默认」（agent 与推理强度同时哑火）。
        // 源码里 getOptionsFromValues 确实返回数组，但那是多选内部路径，不是单选实际走的那条——
        // 这里以运行时实测为准，并且两种形状都兼容，免得再被内部实现变化打中。
        const next = Array.isArray(v) ? (v[0] as T | undefined) : (v as T | null | undefined)
        local.onSelect?.(next ?? undefined)
        stop()
      }}
      onOpenChange={(open) => {
        local.onOpenChange?.(open)
        if (!open) stop()
      }}
    >
      <Kobalte.Trigger
        {...local.triggerProps}
        disabled={props.disabled}
        data-slot="select-select-trigger"
        as={Button}
        size={props.size}
        variant={props.variant}
        style={local.triggerStyle}
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
      >
        <Kobalte.Value<T> data-slot="select-select-trigger-value" class={local.valueClass}>
          {(state) => {
            const selected = state.selectedOption() ?? local.current
            if (!selected) return local.placeholder || ""
            if (local.label) return local.label(selected)
            return selected as string
          }}
        </Kobalte.Value>
        <Kobalte.Icon data-slot="select-select-trigger-icon">
          <Icon name={local.triggerVariant === "settings" ? "selector" : "chevron-down"} size="small" />
        </Kobalte.Icon>
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          classList={{
            ...local.classList,
            [local.class ?? ""]: !!local.class,
          }}
          data-component="select-content"
          data-trigger-style={local.triggerVariant}
        >
          <Kobalte.Listbox data-slot="select-select-content-list" />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
