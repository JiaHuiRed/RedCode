import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, onCleanup, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { anonKey, guiDiagnostics } from "@/context/gui-diagnostics"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { useProviders } from "@/hooks/use-providers"
import { Button } from "@redcode-ai/ui/button"
import { Tag } from "@redcode-ai/ui/tag"
import { Dialog } from "@redcode-ai/ui/dialog"
import { List } from "@redcode-ai/ui/list"
import { Tooltip } from "@redcode-ai/ui/tooltip"
import { ModelTooltip } from "./model-tooltip"
import { ModelEffortPicker, type PickerModel, type PickerProvider } from "./model-effort-picker"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import {
  mergeRecentItems,
  popularFirstProviders,
  recentProviderIDs,
  sortGroupsRecentFirst,
} from "@/utils/model-recents"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "redcode" && (!cost || cost.input === 0)

type ModelState = ReturnType<typeof useLocal>["model"]

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()

  type ModelItem = ReturnType<typeof model.list>[number] & { recent?: boolean }

  // 261114 Red UX-05：最近使用前排——复用 local.model.recent（已解析的模型列表，
  // 按 provider+model 去重），失效/隐藏的记录静默跳过；主列表去重不重复出现。
  const recents = createMemo((): ModelItem[] => {
    const out: ModelItem[] = []
    const seen = new Set<string>()
    for (const entry of model.recent()) {
      if (!entry) continue
      const id = `${entry.provider.id}:${entry.id}`
      if (seen.has(id)) continue
      if (!model.visible({ modelID: entry.id, providerID: entry.provider.id })) continue
      seen.add(id)
      out.push({ ...entry, recent: true })
    }
    return out
  })

  const models = createMemo((): ModelItem[] => {
    const base = model
      .list()
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true))
    if (props.provider) return base
    return mergeRecentItems(recents(), base, (m) => `${m.provider.id}:${m.id}`)
  })

  const recentGroupLabel = language.t("dialog.model.recent")

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      // 261106 Red 几百个模型全量 <For> 渲染 + findByKey 全列表扫描是热路径，
      //   开启 List 的 opt-in 虚拟化：分组摊平后由 virtua 逐窗渲染，高亮跟随走 scrollToIndex。
      virtual
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => ((x as ModelItem).recent ? recentGroupLabel : x.provider.name)}
      sortGroupsBy={sortGroupsRecentFirst<ModelItem>((x) => x.provider.id)}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          openDelay={0}
          value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular">
          <span class="truncate">{i.name}</span>
          <Show when={isFree(i.provider.id, i.cost)}>
            <Tag>{language.t("model.tag.free")}</Tag>
          </Show>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

export function ModelSelectorPopover(props: {
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  /** 返回 true 表示本次打开已被拦截（如未连接付费供应商时改走引导对话框），弹层不开。 */
  interceptOpen?: () => boolean
  /** 思考强度循环快捷键提示，展示在弹层思考强度行尾。 */
  keybindHint?: () => string | undefined
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{ open: boolean; dismiss: Dismiss | null }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const globalSync = useServerSync()
  const model = useLocal().model
  const providers = useProviders()
  const language = useLanguage()

  // 261011 Red B1.1（审计 ZW-07）：Popover 取证统一走 recordPopover——关闭/打开记录
  // 真实 current 存在性与目录匿名 ID；关闭路径补 trigger 再点（toggle）与
  // 开着被卸载（unmount）。
  const hasCurrent = () => Boolean(model.current()?.id)
  const dirKey = () => {
    const directory = globalSync.data.path.directory
    return directory ? anonKey(directory) : "root"
  }
  const recordPopover = (action: string, detail: Record<string, string | boolean> = {}) =>
    guiDiagnostics.record("ui.popover", {
      name: "model-select",
      detail: { action, current: hasCurrent(), dir: dirKey(), ...detail },
    })

  // 弹窗开着时组件被卸载：ZW-06 类「控件消失」的现场信号
  onCleanup(() => {
    if (store.open) recordPopover("unmount")
  })

  const close = (dismiss: Dismiss) => {
    // 261011 Red B0: 弹窗关停留痕（关闭原因 + 当时是否已有选中模型）
    recordPopover("close", { dismiss })
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  // 261121 Red 供应商飞出层数据：已连接供应商按常用清单排序；「最近使用」由模型
  // 最近记录推导（recentProviderIDs），不下真实供应商级 recency。
  const providersList = (): PickerProvider[] =>
    popularFirstProviders(providers.connected().map((p) => ({ id: p.id, name: p.name, source: p.source })))
  const recentList = () => recentProviderIDs(model.recent(), (item) => item.provider.id)
  const modelsFor = (providerID: string): PickerModel[] =>
    model
      .list()
      .filter((m) => m.provider.id === providerID && model.visible({ modelID: m.id, providerID: m.provider.id }))
      .map((m) => ({ providerID: m.provider.id, modelID: m.id, name: m.name, cost: m.cost, latest: m.latest }))
  const currentKey = () => {
    const item = model.current()
    return item ? { providerID: item.provider.id, modelID: item.id } : undefined
  }

  // 261121 Red 概览/列表两态机换成统一弹层：供应商行悬停飞出层 + 浏览供应商模型 +
  // 思考强度滑杆一屏呈现。内容容器不能加 overflow-hidden——供应商飞出层是普通
  // 绝对定位子元素，加了会被裁掉。
  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next && props.interceptOpen?.()) return
        if (next) globalSync.wantProviderCatalog()
        if (next) setStore("dismiss", null)
        if (next) recordPopover("open")
        // 261011 Red B1.1（审计 ZW-07）：trigger 再点击（toggle）的关闭此前无任何记录；
        // 其余关闭路径（escape/outside/select/manage/provider）都经 close() 已记录——
        // dismiss 非空即表示本次关闭已记录过，跳过避免重复。
        if (!next && !store.dismiss) recordPopover("close", { dismiss: "toggle" })
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      {/* 261011 Red B1.1（审计 ZW-07）：trigger-pointerdown 是最便宜的开合时序锚点。
          真实调用方仅 prompt-input 一处且未经 triggerProps 传 onPointerDown。 */}
      <Kobalte.Trigger
        as={props.triggerAs ?? "div"}
        {...props.triggerProps}
        onPointerDown={() => recordPopover("trigger-pointerdown", { open: store.open })}
      >
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="flex max-h-[min(32rem,72vh)] w-80 flex-col rounded-xl border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelEffortPicker
            open={() => store.open}
            providers={providersList}
            recentProviderIDs={recentList}
            models={modelsFor}
            currentModel={currentKey}
            onModelSelect={(picked) => {
              model.set({ providerID: picked.providerID, modelID: picked.modelID }, { recent: true })
              close("select")
            }}
            onManage={handleManage}
            onConnect={handleConnectProvider}
            effort={{
              steps: model.variant.list(),
              current: () => model.variant.current(),
              onChange: (value) => model.variant.set(value),
              unselectedLabel: language.t("prompt.variant.modelDefault"),
            }}
            keybindHint={props.keybindHint}
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  useServerSync().wantProviderCatalog()

  const provider = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
