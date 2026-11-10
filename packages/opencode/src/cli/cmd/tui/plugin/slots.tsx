import type { TuiPluginApi, TuiSlotContext, TuiSlotMap, TuiSlotProps } from "@redcode-ai/plugin/tui"
import { createSlot, createSolidSlotRegistry, type JSX, type SolidPlugin } from "@opentui/solid"
import { isRecord } from "@/util/record"

type RuntimeSlotMap = TuiSlotMap<Record<string, object>>

type Slot = <Name extends string>(props: TuiSlotProps<Name>) => JSX.Element | null
export type HostSlotPlugin<Slots extends Record<string, object> = {}> = SolidPlugin<TuiSlotMap<Slots>, TuiSlotContext>

export type HostPluginApi = TuiPluginApi
export type HostSlots = {
  register: {
    (plugin: HostSlotPlugin): () => void
    <Slots extends Record<string, object>>(plugin: HostSlotPlugin<Slots>): () => void
  }
}

function empty<Name extends string>(_props: TuiSlotProps<Name>) {
  return null
}

let view: Slot = empty

// 261110 Red 同一个 renderer 复用同一份 slot registry（项目切换会重新 init 插件运行时）。
const registries = new WeakMap<object, HostSlots>()

export const Slot: Slot = (props) => view(props)

function isHostSlotPlugin(value: unknown): value is HostSlotPlugin<Record<string, object>> {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string") return false
  if (!isRecord(value.slots)) return false
  return true
}

export function setupSlots(api: HostPluginApi): HostSlots {
  // 261110 Red 每个 renderer 只允许一个 slot registry：切换项目会重新 init 插件运行时，
  // 再次 createSolidSlotRegistry 会抛 "called with a different context" 让整个 TUI 崩掉。
  const existing = registries.get(api.renderer)
  if (existing) return existing
  const reg = createSolidSlotRegistry<RuntimeSlotMap, TuiSlotContext>(
    api.renderer,
    {
      theme: api.theme,
    },
    {
      onPluginError(event) {
        console.error("[tui.slot] plugin error", {
          plugin: event.pluginId,
          slot: event.slot,
          phase: event.phase,
          source: event.source,
          message: event.error.message,
        })
      },
    },
  )

  const slot = createSlot<RuntimeSlotMap, TuiSlotContext>(reg)
  view = (props) => slot(props)
  const shell: HostSlots = {
    register(plugin: HostSlotPlugin) {
      if (!isHostSlotPlugin(plugin)) return () => {}
      return reg.register(plugin)
    },
  }
  registries.set(api.renderer, shell)
  return shell
}
