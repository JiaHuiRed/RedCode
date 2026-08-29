import { Select } from "@redcode-ai/ui/select"
import { showToast } from "@redcode-ai/ui/toast"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, For, Show, type Component } from "solid-js"
import type { Agent } from "@redcode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSync } from "@/context/server-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { loadAgentsQuery } from "@/context/global-sync/bootstrap"
import { SettingsList, SettingsRow } from "./settings-list"

// 260829 Red 配置里 model 是 "providerID/modelID"，未配置时这一行整个不写。
// 引擎侧两处 `data.model ? …` 是真值判断（config/agent.ts:206/351），空串与“没写这一行”同义，
// 而 HTTP 请求体会把 undefined 丢掉，所以面板发空串、由 updateGlobal 落盘前翻译成删键。
// 下拉内部不能用空串/0 当选项值——Kobalte 的选中态对 falsy key 判定不稳（实测选项显示空白或串位），
// 所以界面上用哨兵值，落库前再翻译。
const FOLLOW = "__follow__"
const modelValue = (key: string) => (key === FOLLOW ? "" : key)
// "default" 是引擎约定的“不指定档位”：prompt.ts 只认模型 variants 里真实存在的档位名
const DEFAULT_VARIANT = "default"

const TIMEOUTS = [
  { id: "none", ms: 0 },
  { id: "5m", ms: 300_000 },
  { id: "10m", ms: 600_000 },
  { id: "30m", ms: 1_800_000 },
]

type ModelOption = { key: string; label: string; group: string }

export const SettingsAgents: Component = () => {
  const language = useLanguage()
  const globalSync = useServerSync()
  const globalSDK = useGlobalSDK()
  const queryClient = useQueryClient()
  const models = useModels()

  // 260829 Red 智能体列表按目录取（项目 agent/ 目录能自定义），设置面板写的是全局配置，
  // 所以这里用不带目录的全局查询——拿到的是内建工种 + 全局配置里的角色。
  const agentsQuery = () => loadAgentsQuery(null, globalSDK.client)
  const agents = useQuery(agentsQuery)
  const list = createMemo(() => agents.data ?? [])

  const primary = createMemo(() => list().filter((a) => !a.hidden && a.mode === "primary"))
  const subagents = createMemo(() => list().filter((a) => !a.hidden && a.mode !== "primary"))

  const sections = createMemo(() =>
    [
      { title: language.t("settings.agents.section.primary"), items: primary() },
      { title: language.t("settings.agents.section.subagent"), items: subagents() },
    ].filter((section) => section.items.length > 0),
  )

  const update = (name: string, patch: Record<string, string | number>) => {
    globalSync
      .updateConfig({ agent: { [name]: patch } })
      .then(() => queryClient.invalidateQueries({ queryKey: agentsQuery().queryKey }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const AgentCard: Component<{ agent: Agent }> = (props) => {
    const key = (model?: { providerID: string; modelID: string }) =>
      model ? `${model.providerID}/${model.modelID}` : FOLLOW

    const modelKey = () => key(props.agent.model) || FOLLOW
    const fallbackKey = () => key(props.agent.fallbackModel) || FOLLOW
    const variant = () => props.agent.variant ?? DEFAULT_VARIANT

    // 档位集合按模型变（models.dev 的 reasoning_options）：Hy4 preview 只有 none/high，别家是
    // low/medium/high/max。换模型后旧档位可能不存在——prompt.ts 会丢掉无效值，这里同步改回默认。
    const variantOptions = () => variantsFor(modelKey())

    function variantsFor(model: string) {
      const [providerID, modelID] = model.split("/")
      const found = model === FOLLOW ? undefined : models.find({ providerID, modelID })
      return [DEFAULT_VARIANT, ...Object.keys(found?.variants ?? {})]
    }

    const modelOptions = (current: string, empty: string): ModelOption[] => {
      const first: ModelOption = {
        key: FOLLOW,
        label: empty,
        group: language.t("settings.agents.group.default"),
      }
      const items = models
        .list()
        .filter(
          (m) =>
            `${m.provider.id}/${m.id}` === current ||
            models.visible({ providerID: m.provider.id, modelID: m.id }),
        )
        .map((m) => ({ key: `${m.provider.id}/${m.id}`, label: m.name, group: m.provider.name }))
      return [first, ...items]
    }

    // 手改配置可以写出任意毫秒数，预设档盖不住时把当前值补成一项，别让下拉显示空白
    const timeoutOptions = () => {
      const current = props.agent.timeoutMs ?? 0
      const items = TIMEOUTS.some((x) => x.ms === current) ? TIMEOUTS : [{ id: String(current), ms: current }, ...TIMEOUTS]
      return items.map((x) => ({
        ...x,
        label:
          x.ms === 0
            ? language.t("settings.agents.timeout.none")
            : language.t("settings.agents.timeout.minutes", { count: x.ms / 60_000 }),
      }))
    }

    const selectModel = (option: ModelOption | undefined) => {
      if (!option || option.key === modelKey()) return
      const patch: Record<string, string | number> = { model: modelValue(option.key) }
      if (!variantsFor(option.key).includes(variant())) patch.variant = DEFAULT_VARIANT
      update(props.agent.name, patch)
    }

    const modelSelect = (action: string, current: string, empty: string, onSelect: (o: ModelOption) => void) => (
      <Select
        data-action={action}
        options={modelOptions(current, empty)}
        current={modelOptions(current, empty).find((o) => o.key === current)}
        value={(o: ModelOption) => o.key}
        label={(o: ModelOption) => o.label}
        groupBy={(o: ModelOption) => o.group}
        onSelect={(option: ModelOption | undefined) => option && onSelect(option)}
        variant="secondary"
        size="small"
        triggerVariant="settings"
        triggerStyle={{ "min-width": "260px" }}
      />
    )

    return (
      <SettingsList>
        <div class="flex flex-col gap-0.5 py-3 border-b border-border-weak-base">
          <span class="text-14-medium text-text-strong">{props.agent.displayName ?? props.agent.name}</span>
          <Show when={props.agent.description}>
            <span class="text-12-regular text-text-weak">{props.agent.description}</span>
          </Show>
        </div>

        <SettingsRow
          title={language.t("settings.agents.model.title")}
          description={language.t("settings.agents.model.description")}
        >
          {modelSelect(`settings-agent-model-${props.agent.name}`, modelKey(), language.t("settings.agents.model.follow"), selectModel)}
        </SettingsRow>

        <Show when={modelKey() !== FOLLOW && variantOptions().length > 1}>
          <SettingsRow
            title={language.t("settings.agents.variant.title")}
            description={language.t("settings.agents.variant.description")}
          >
            <Select
              data-action={`settings-agent-variant-${props.agent.name}`}
              options={variantOptions()}
              current={variantOptions().find((o) => o === variant())}
              value={(o: string) => o}
              label={(o: string) => (o === DEFAULT_VARIANT ? language.t("common.default") : o)}
              onSelect={(option: string | undefined) => {
                if (!option || option === variant()) return
                update(props.agent.name, { variant: option })
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
              triggerStyle={{ "min-width": "180px" }}
            />
          </SettingsRow>
        </Show>

        <Show when={props.agent.mode !== "primary"}>
          <SettingsRow
            title={language.t("settings.agents.timeout.title")}
            description={language.t("settings.agents.timeout.description")}
          >
            <Select
              data-action={`settings-agent-timeout-${props.agent.name}`}
              options={timeoutOptions()}
              current={timeoutOptions().find((o) => o.ms === (props.agent.timeoutMs ?? 0))}
              value={(o) => o.id}
              label={(o) => o.label}
              onSelect={(option) => {
                if (!option) return
                update(props.agent.name, { timeout_ms: option.ms })
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
              triggerStyle={{ "min-width": "180px" }}
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.agents.fallback.title")}
            description={language.t("settings.agents.fallback.description")}
          >
            {modelSelect(
              `settings-agent-fallback-${props.agent.name}`,
              fallbackKey(),
              language.t("settings.agents.fallback.none"),
              (option) => {
                if (option.key === fallbackKey()) return
                update(props.agent.name, { fallback_model: modelValue(option.key) })
              },
            )}
          </SettingsRow>
        </Show>
      </SettingsList>
    )
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.agents.title")}</h2>
          <span class="text-14-regular text-text-weak">{language.t("settings.agents.description")}</span>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <For each={sections()}>
          {(section) => (
            <div class="flex flex-col gap-1">
              <h3 class="text-14-medium text-text-strong pb-2">{section.title}</h3>
              <div class="flex flex-col gap-4">
                <For each={section.items}>{(agent) => <AgentCard agent={agent} />}</For>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
