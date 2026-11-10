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
// context 保持同一个对象：registry 只保存引用，插件每次渲染都从它上面取最新主题。
type SlotHost = { slots: HostSlots; context: TuiSlotContext }
const registries = new WeakMap<object, SlotHost>()

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
  // registry 复用，但主题上下文要跟着本次 init 换：ThemeProvider 已随项目重建，
  // 继续用第一次的 api.theme 会让 B 项目的插件继续显示 A 项目的配色。
  const existing = registries.get(api.renderer)
  if (existing) {
    existing.context.theme = api.theme
    return existing.slots
  }
  const context: TuiSlotContext = { theme: api.theme }
  const reg = createSolidSlotRegistry<RuntimeSlotMap, TuiSlotContext>(api.renderer, context, {
    onPluginError(event) {
      console.error("[tui.slot] plugin error", {
        plugin: event.pluginId,
        slot: event.slot,
        phase: event.phase,
        source: event.source,
        message: event.error.message,
      })
    },
  })

  const slot = createSlot<RuntimeSlotMap, TuiSlotContext>(reg)
  view = (props) => slot(props)
  const shell: HostSlots = {
    register(plugin: HostSlotPlugin) {
      if (!isHostSlotPlugin(plugin)) return () => {}
      return reg.register(plugin)
    },
  }
  registries.set(api.renderer, { slots: shell, context })
  return shell
}
