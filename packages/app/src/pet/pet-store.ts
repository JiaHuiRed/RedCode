import { createStore, produce } from "solid-js/store"
import {
  applyPetEvent,
  beginPetBootstrap,
  createPetState,
  finishPetBootstrap,
  recordPetBootstrapEvent,
  settlePetBootstrap as settlePetBootstrapState,
  type PetEvent,
  type PetState,
} from "./pet-state"

// 260929 Red Pet 状态是进程内存态单例（设计文档：Pet 零持久化、重启归零）。
// 模块级 createStore 无 owner 依赖；超时 tick 由 PetLayer 组件持有并随卸载清理。
const [state, setState] = createStore<PetState>(createPetState())

export function petState() {
  return state
}

/** server-sync 事件流唯一入口。所有事件（global 与 directory 级）都可喂入，reducer 自行过滤。 */
export function feedPetEvent(event: PetEvent, directory: string) {
  const now = Date.now()
  setState(
    produce((draft) => {
      applyPetEvent(draft, event, now)
      recordPetBootstrapEvent(draft, directory, event)
      const props = (event.properties ?? {}) as { sessionID?: string; part?: { sessionID?: string } }
      const id = props.sessionID ?? props.part?.sessionID
      if (!id) return
      if (draft.flash?.sessionID === id && draft.flash.at === now) draft.flash.directory = directory
      if (draft.sessions[id] || draft.blockers[id]) draft.owners[id] = directory
      else delete draft.owners[id]
    }),
  )
}

export function startPetBootstrap(directory: string) {
  setState(produce((draft) => beginPetBootstrap(draft, directory)))
}

// 261031 Red 目录 bootstrap 收尾：丢弃残余 journal。正常路径的分区已由 settlePetBootstrap
// 在快照写入时清算并重放；到这里剩下的只有失败轮（快照没写入，无需修正）。
export function endPetBootstrap(directory: string): void {
  setState(produce((draft) => {
    finishPetBootstrap(draft, directory)
  }))
}

// 261031 Red 快照写入完成时按分区清算 journal，交由调用方（server-sync）重放到 child store。
export function settlePetBootstrap(directory: string, kind: "permission" | "question" | "session.status"): PetEvent[] {
  let events: PetEvent[] = []
  setState(produce((draft) => { events = settlePetBootstrapState(draft, directory, kind) }))
  return events
}
