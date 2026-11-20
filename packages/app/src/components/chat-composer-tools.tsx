import { Popover as Kobalte } from "@kobalte/core/popover"
import { For, Show, createMemo, createSignal, type Component, type JSX } from "solid-js"
import { Button } from "@redcode-ai/ui/button"
import { Icon } from "@redcode-ai/ui/icon"
import { List } from "@redcode-ai/ui/list"
import { ProviderIcon } from "@redcode-ai/ui/provider-icon"
import { EffortSliderV2, availableEffortSteps } from "@redcode-ai/ui/v2/components/effort-slider-v2.jsx"
import type { useModels, ModelKey } from "@/context/models"
import { useLanguage } from "@/context/language"

type Entry = {
  providerID: string
  providerName: string
  modelID: string
  name: string
  variants: string[]
}

export const ChatComposerTools: Component<{
  catalog: ReturnType<ReturnType<typeof useModels>["catalog"]>
  disabled?: boolean
  model: ModelKey | undefined
  variant: string | undefined
  onModelChange: (value: ModelKey | undefined) => void
  onVariantChange: (value: string | undefined) => void
  class?: string
}> = (props) => {
  const language = useLanguage()
  const [open, setOpen] = createSignal<"model" | "variant" | null>(null)

  const entries = createMemo((): Entry[] => {
    return props.catalog
      .list()
      .filter((model) => props.catalog.visible({ providerID: model.provider.id, modelID: model.id }))
      .map((model) => ({
        providerID: model.provider.id,
        providerName: model.provider.name,
        modelID: model.id,
        name: model.name,
        variants: Object.keys(model.variants ?? {}),
      }))
  })

  const current = createMemo(() =>
    props.model
      ? entries().find((item) => item.providerID === props.model!.providerID && item.modelID === props.model!.modelID)
      : undefined,
  )

  const steps = createMemo(() => availableEffortSteps(current()?.variants ?? []))

  const select = (entry: Entry | undefined) => {
    if (!entry) return
    props.onModelChange({ providerID: entry.providerID, modelID: entry.modelID })
    setOpen(null)
  }

  const modelList = (action?: JSX.Element) => (
    <List
      class="h-96 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
      virtual
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(item: Entry) => `${item.providerID}:${item.modelID}`}
      items={entries()}
      current={current()}
      filterKeys={["providerName", "name", "modelID"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(item: Entry) => item.providerName}
      onSelect={(item) => select(item as Entry | undefined)}
    >
      {(item: Entry) => (
        <div class="flex w-full items-center gap-x-2 text-13-regular">
          <span class="truncate">{item.name}</span>
        </div>
      )}
    </List>
  )

  return (
    <div class={`flex min-w-0 flex-wrap items-center gap-1 ${props.class ?? ""}`}>
      <Kobalte
        open={open() === "model"}
        onOpenChange={(value) => setOpen(value ? "model" : null)}
        placement="top-start"
        gutter={8}
      >
        <Kobalte.Trigger
          as={Button}
          variant="ghost"
          size="small"
          disabled={props.disabled}
          data-action="chat-choose-model"
          class="min-w-0 max-w-[220px] justify-start gap-1.5 text-12-regular text-text-weak"
        >
          <Show when={current()?.providerID}>
            {(providerID) => <ProviderIcon id={providerID()} class="size-3.5 shrink-0" role="img" aria-hidden />}
          </Show>
          <span class="truncate">{current()?.name ?? language.t("chat.composer.model.auto")}</span>
          <Icon name="chevron-down" size="small" class="shrink-0" />
        </Kobalte.Trigger>
        <Kobalte.Portal>
          <Kobalte.Content
            data-component="chat-model-popover"
            class="z-50 flex max-h-[min(32rem,72vh)] w-80 flex-col overflow-hidden rounded-xl border border-border-weak-base bg-surface-raised-base p-2 shadow-lg"
          >
            {modelList()}
            <Show when={props.model}>
              <div class="mt-2 shrink-0 border-t border-border-weak-base pt-2">
                <Button
                  variant="ghost"
                  size="small"
                  class="w-full justify-start text-12-regular text-text-weak"
                  onClick={() => {
                    props.onModelChange(undefined)
                    setOpen(null)
                  }}
                >
                  {language.t("chat.composer.model.auto")}
                </Button>
              </div>
            </Show>
          </Kobalte.Content>
        </Kobalte.Portal>
      </Kobalte>

      <Show when={steps().length > 0}>
        <Kobalte
          open={open() === "variant"}
          onOpenChange={(value) => setOpen(value ? "variant" : null)}
          placement="top-start"
          gutter={8}
        >
          <Kobalte.Trigger
            as={Button}
            variant="ghost"
            size="small"
            disabled={props.disabled}
            data-action="chat-choose-variant"
            class="min-w-0 max-w-[140px] justify-start gap-1.5 text-12-regular capitalize text-text-accent"
          >
            <Icon name="brain" size="small" class="shrink-0" />
            <span class="truncate">{props.variant ?? language.t("prompt.variant.modelDefault")}</span>
            <Icon name="chevron-down" size="small" class="shrink-0" />
          </Kobalte.Trigger>
          <Kobalte.Portal>
            <Kobalte.Content
              data-component="chat-variant-popover"
              class="z-50 flex w-64 flex-col gap-3 rounded-xl border border-border-weak-base bg-surface-raised-base p-3 shadow-lg"
            >
              <EffortSliderV2
                steps={steps()}
                current={props.variant}
                title={language.t("settings.agents.variant.title")}
                unselectedLabel={language.t("prompt.variant.modelDefault")}
                onChange={(value) => props.onVariantChange(value)}
                style={{
                  "--effort-slider-v2-width": "100%",
                  "--effort-slider-v2-height": "24px",
                  "--effort-slider-v2-thumb-size": "28px",
                }}
              />
              <div class="flex items-baseline justify-between gap-2 text-11-regular text-text-weak">
                <span>{language.t("prompt.variant.faster")}</span>
                <span>{language.t("prompt.variant.smarter")}</span>
              </div>
            </Kobalte.Content>
          </Kobalte.Portal>
        </Kobalte>
      </Show>
    </div>
  )
}
