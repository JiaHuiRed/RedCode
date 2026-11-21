import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import { Icon } from "@redcode-ai/ui/icon"
import { Tag } from "@redcode-ai/ui/tag"
import { ProviderIcon } from "@redcode-ai/ui/provider-icon"
import {
  EffortSliderV2,
  availableEffortSteps,
  effortStepTone,
  selectedEffortIndex,
} from "@redcode-ai/ui/v2/components/effort-slider-v2.jsx"
import { useLanguage } from "@/context/language"
import "./model-effort-picker.css"

export type PickerProvider = { id: string; name: string; source?: string }

export type PickerModel = {
  providerID: string
  modelID: string
  name: string
  cost?: { input: number }
  latest?: boolean
}

export interface ModelEffortPickerProps {
  /** 弹层开合。打开那一刻浏览态重置为当前模型的供应商（或第一个可用供应商）。 */
  open: () => boolean
  providers: () => PickerProvider[]
  /** 最近使用过的供应商 ID（由模型最近记录推导），飞出层前排。 */
  recentProviderIDs: () => string[]
  /** 该供应商下可见的模型，调用方已做可见性过滤。 */
  models: (providerID: string) => PickerModel[]
  currentModel: () => { providerID: string; modelID: string } | undefined
  onModelSelect: (model: PickerModel) => void
  /** 默认模型行（仅 Chat 首页），提交 undefined 表示回到服务端默认；不给就不渲染。 */
  onReset?: () => void
  onManage: () => void
  /** 连接新供应商的入口；不给就不渲染该行（Chat 首页走设置弹窗时传打开设置）。 */
  onConnect?: () => void
  effort: {
    steps: readonly string[]
    current: () => string | undefined
    onChange: (value: string) => void
    unselectedLabel: string
    /** 档位显示名转换，缺省原值。 */
    label?: (value: string) => string
  }
  /** 思考强度的循环快捷键提示（如 ⇧Ctrl+D），缺省不显示 kbd。 */
  keybindHint?: () => string | undefined
}

// 261121 Red 与 dialog-select-model 的 isFree 同一判定；redcode 免费模型挂「免费」标。
const isFree = (providerID: string, cost: { input: number } | undefined) =>
  providerID === "redcode" && (!cost || cost.input === 0)

/**
 * 261121 Red 统一模型选择弹层内容：供应商行（悬停出右侧飞出层，最近使用→全部供应商→
 * 管理模型）→ 当前浏览供应商的模型 → （可选）默认模型 → 思考强度滑杆。Code 会话与
 * Chat 首页共用，两侧状态差异由调用方经 props 适配。浏览态只在弹层内切换供应商，
 * 点模型才提交选择——换供应商本身不改动已选模型。
 */
export const ModelEffortPicker: Component<ModelEffortPickerProps> = (props) => {
  const language = useLanguage()
  const [browse, setBrowse] = createSignal("")
  const [flyout, setFlyout] = createSignal(false)
  // 261121 Red 方案③：飞出层固定贴右侧、宽 248px——弹层靠近屏幕右缘（分屏/窄窗/
  // 125% 缩放）时子层整个出界，最后一个供应商选不到。现在打开时量一次：右侧放得下
  // 贴右，放不下贴左，两侧都放不下就不飞出，改为面板内切换「供应商 → 模型」两个视图。
  // 触屏没有 hover：供应商行点击=打开/切换，选完供应商收起并把焦点移到模型列表。
  const [side, setSide] = createSignal<"right" | "left" | "panel">("right")
  const [panelProviders, setPanelProviders] = createSignal(false)
  let zoneRef: HTMLDivElement | undefined
  let modelListRef: HTMLDivElement | undefined

  const FLYOUT_WIDTH = 248
  const FLYOUT_MARGIN = 8

  const measureSide = (): "right" | "left" | "panel" => {
    const rect = zoneRef?.getBoundingClientRect()
    if (!rect) return "right"
    if (rect.right + FLYOUT_WIDTH <= window.innerWidth - FLYOUT_MARGIN) return "right"
    if (rect.left - FLYOUT_WIDTH >= FLYOUT_MARGIN) return "left"
    return "panel"
  }

  // 打开即重置浏览态：当前模型的供应商优先，没有就落第一个可用供应商。
  createEffect(() => {
    if (!props.open()) return
    const current = props.currentModel()?.providerID
    if (current) {
      setBrowse(current)
    } else {
      setBrowse(props.providers()[0]?.id ?? "")
    }
    setSide(measureSide())
    setPanelProviders(false)
    setFlyout(false)
  })

  // 悬停开合（含少量延迟防误触）；飞出层是行的兄弟节点，鼠标滑过去不断触。
  // 面板模式不悬停自动展开——悬停就换走整个面板正文太吵，点击才切换。
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const enter = () => {
    if (closeTimer !== undefined) clearTimeout(closeTimer)
    if (flyout()) return
    openTimer = setTimeout(() => {
      const measured = measureSide()
      setSide(measured)
      if (measured !== "panel") setFlyout(true)
    }, 120)
  }
  const leave = () => {
    if (openTimer !== undefined) clearTimeout(openTimer)
    closeTimer = setTimeout(() => setFlyout(false), 150)
  }
  onCleanup(() => {
    if (openTimer !== undefined) clearTimeout(openTimer)
    if (closeTimer !== undefined) clearTimeout(closeTimer)
  })

  // 供应商行的点击=打开（触屏/键盘主路径）。飞出模式展开子层；面板模式在
  // 「供应商 → 模型」两个视图间切换。
  const openFlyout = () => {
    const measured = measureSide()
    setSide(measured)
    if (measured === "panel") setPanelProviders((value) => !value)
    else setFlyout(true)
  }

  // 选供应商：只换浏览态不提交模型；子层/面板供应商视图收起，焦点移到模型列表。
  const chooseProvider = (id: string) => {
    setBrowse(id)
    setFlyout(false)
    setPanelProviders(false)
    modelListRef?.focus({ preventScroll: true })
  }

  const browsed = () => props.providers().find((p) => p.id === browse())
  const browseModels = () => (browse() ? props.models(browse()) : [])
  const current = () => props.currentModel()

  const providerTag = (provider: PickerProvider) => {
    if (provider.id === "redcode" || provider.id === "redcode-go")
      return language.t("dialog.provider.tag.recommended")
    if (provider.source === "custom") return language.t("settings.providers.tag.custom")
    return undefined
  }

  const recent = () => {
    const ids = new Set(props.recentProviderIDs())
    const connected = new Map(props.providers().map((p) => [p.id, p]))
    return [...ids].flatMap((id) => {
      const provider = connected.get(id)
      return provider ? [provider] : []
    })
  }
  const rest = () => props.providers().filter((p) => !props.recentProviderIDs().includes(p.id))

  const effortSteps = () => availableEffortSteps(props.effort.steps)
  const effortIndex = () => selectedEffortIndex(effortSteps(), props.effort.current())
  const effortValue = () => {
    const index = effortIndex()
    if (index < 0) return props.effort.unselectedLabel
    const step = effortSteps()[index]
    return step === undefined ? props.effort.unselectedLabel : (props.effort.label?.(step) ?? step)
  }

  const flyRow = (provider: PickerProvider) => (
    <button type="button" class="mep-fly-row" onClick={() => chooseProvider(provider.id)}>
      <ProviderIcon id={provider.id} class="size-4.5 shrink-0" role="img" aria-hidden />
      <span class="p-name">{provider.name}</span>
      <Show when={providerTag(provider)}>
        {(tag) => (
          <span class="mep-row-tags">
            <Tag>{tag()}</Tag>
          </span>
        )}
      </Show>
      <Show when={provider.id === browse()}>
        <span class="p-ok" aria-hidden="true">
          <Icon name="check-small" size="small" />
        </span>
      </Show>
    </button>
  )

  // 供应商列表内容（最近使用 → 全部 → 管理/连接），飞出层与面板内供应商视图共用。
  const providerRows = () => (
    <>
      <Show when={recent().length > 0}>
        <p class="mep-fly-label">{language.t("dialog.model.recent")}</p>
        <For each={recent()}>{flyRow}</For>
      </Show>
      <Show when={rest().length > 0}>
        <p class="mep-fly-label">{language.t("dialog.provider.group.all")}</p>
        <For each={rest()}>{flyRow}</For>
      </Show>
      <div class="mep-fly-manage">
        <button
          type="button"
          class="mep-fly-row"
          onClick={() => {
            setFlyout(false)
            setPanelProviders(false)
            props.onManage()
          }}
        >
          <Icon name="sliders" size="small" class="shrink-0" />
          <span class="p-name">{language.t("dialog.model.manage")}</span>
        </button>
        <Show when={props.onConnect}>
          <button
            type="button"
            class="mep-fly-row"
            onClick={() => {
              setFlyout(false)
              setPanelProviders(false)
              props.onConnect?.()
            }}
          >
            <Icon name="plus-small" size="small" class="shrink-0" />
            <span class="p-name">{language.t("command.provider.connect")}</span>
          </button>
        </Show>
      </div>
    </>
  )

  return (
    <div data-component="model-effort-picker">
      <div
        class="mep-provider-zone"
        ref={zoneRef}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onKeyDown={(event) => {
          if (event.key === "Escape" && (flyout() || panelProviders())) {
            event.stopPropagation()
            setFlyout(false)
            setPanelProviders(false)
          }
        }}
      >
        <button
          type="button"
          class="mep-provider-row"
          onClick={openFlyout}
          aria-expanded={flyout() || (side() === "panel" && panelProviders())}
        >
          <Show when={browsed()} fallback={<span class="p-name">{language.t("dialog.model.select.title")}</span>}>
            {(provider) => (
              <>
                <ProviderIcon id={provider().id} class="size-5 shrink-0" role="img" aria-hidden />
                <span class="p-name">{provider().name}</span>
                <Show when={providerTag(provider())}>
                  {(tag) => (
                    <span class="mep-row-tags">
                      <Tag>{tag()}</Tag>
                    </span>
                  )}
                </Show>
              </>
            )}
          </Show>
          <span class="p-go" aria-hidden="true">
            <Icon name="chevron-right" size="small" />
          </span>
        </button>
        <Show when={flyout() && (recent().length > 0 || rest().length > 0)}>
          <div class="mep-flyout" data-side={side()} onMouseEnter={enter} onMouseLeave={leave}>
            {providerRows()}
          </div>
        </Show>
      </div>

      <Show
        when={side() === "panel" && panelProviders()}
        fallback={
          <>
            <div class="mep-divider" />
            <p class="mep-section-label">{language.t("dialog.model.section.models")}</p>
            <div class="mep-model-list" ref={modelListRef} tabindex="-1">
              <For each={browseModels()}>
                {(model) => (
                  <button type="button" class="mep-model-row" onClick={() => props.onModelSelect(model)}>
                    <span class="m-name">{model.name}</span>
                    <span class="mep-row-tags">
                      <Show when={isFree(model.providerID, model.cost)}>
                        <Tag>{language.t("model.tag.free")}</Tag>
                      </Show>
                      <Show when={model.latest}>
                        <Tag>{language.t("model.tag.latest")}</Tag>
                      </Show>
                    </span>
                    <Show when={current()?.providerID === model.providerID && current()?.modelID === model.modelID}>
                      <span class="m-ok" aria-hidden="true">
                        <Icon name="check-small" size="small" />
                      </span>
                    </Show>
                  </button>
                )}
              </For>
              <Show when={browseModels().length === 0}>
                <p class="mep-section-label">{language.t("dialog.model.empty")}</p>
              </Show>
            </div>

            <Show when={props.onReset}>
              <button type="button" class="mep-model-row mep-auto-row" onClick={() => props.onReset?.()}>
                {language.t("chat.composer.model.auto")}
              </button>
            </Show>

            <Show when={effortSteps().length > 0}>
              <div class="mep-divider" />
              <div class="mep-effort-head">
                <span class="e-label">{language.t("prompt.effort.label")}</span>
                <span
                  class="e-value"
                  data-effort-tone={effortIndex() >= 0 ? effortStepTone(effortIndex()) : undefined}
                >
                  {effortValue()}
                </span>
                <Show when={props.keybindHint?.()}>
                  {(hint) => <kbd>{hint()}</kbd>}
                </Show>
              </div>
        <div class="mep-effort-slider-wrap">
          <EffortSliderV2
            class="mep-effort-slider"
            steps={effortSteps()}
            current={props.effort.current()}
            label={props.effort.label}
            title={language.t("settings.agents.variant.title")}
            unselectedLabel={props.effort.unselectedLabel}
            onChange={props.effort.onChange}
            style={{
              "--effort-slider-v2-width": "100%",
              "--effort-slider-v2-height": "24px",
              "--effort-slider-v2-thumb-size": "28px",
            }}
          />
        </div>
            </Show>
          </>
        }
      >
        {/* 261121 Red 方案③：两侧都放不下时的面板内供应商视图——替换模型区，选中即回模型列表 */}
        <div class="mep-divider" />
        <div class="mep-model-list mep-panel-providers" tabindex="-1">
          {providerRows()}
        </div>
      </Show>
    </div>
  )
}
