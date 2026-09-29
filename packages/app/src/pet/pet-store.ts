import { createStore, produce } from "solid-js/store"
import { applyPetEvent, createPetState, type PetEvent, type PetState } from "./pet-state"

// 260929 Red Pet 状态是进程内存态单例（设计文档：Pet 零持久化、重启归零）。
// 模块级 createStore 无 owner 依赖；超时 tick 由 PetLayer 组件持有并随卸载清理。
const [state, setState] = createStore<PetState>(createPetState())

export function petState() {
  return state
}

/** server-sync 事件流唯一入口。所有事件（global 与 directory 级）都可喂入，reducer 自行过滤。 */
export function feedPetEvent(event: PetEvent) {
  setState(
    produce((draft) => {
      applyPetEvent(draft, event, Date.now())
    }),
  )
}
