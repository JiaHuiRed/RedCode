import type { DesktopPetSnapshot } from "@redcode-ai/ui/desktop-pet"
import type { PetSourceKind } from "@redcode-ai/ui/pet-host"

// 261119 Red TUI/GUI 共用桌宠的来源仲裁（纯 FSM，Electron 无关，可独立测试）。
// 决策边界 → docs/notes/proposed/feature/2026-11-18-tui-shared-desktop-pet.md：
// 显式激活接管、无法判断焦点时保持当前来源、断连由宿主兜底释放、旧代次/旧序号不得覆盖新快照。

export type RegistrySource = {
  sourceID: string
  kind: PetSourceKind
  generation: number
  sequence: number
  snapshot: DesktopPetSnapshot | null
  activationOrder: number
  connected: boolean
}

/** 当前选中来源与其最新快照；snapshot 为 null（或来源还没推过快照）= 不显示。 */
export type PetActiveDisplay = {
  sourceID: string
  kind: PetSourceKind
  snapshot: DesktopPetSnapshot | null
}

export type PetHostRegistry = ReturnType<typeof createPetHostRegistry>

export function createPetHostRegistry(deps: {
  onChange: () => void
  /** 显式激活成功时回调（在 onChange 之前）：宿主用它清掉「点 × 只关本次」的 latch。 */
  onActivate?: (sourceID: string) => void
}) {
  const sources = new Map<string, RegistrySource>()
  let activationOrder = 0

  const changed = () => deps.onChange()

  /** 连接且显式激活过的来源按激活顺序取最后一个；快照未推过按不显示处理。 */
  function pickActive(): PetActiveDisplay | undefined {
    let best: RegistrySource | undefined
    for (const source of sources.values()) {
      if (source.connected && source.activationOrder > (best?.activationOrder ?? 0)) best = source
    }
    if (!best) return undefined
    return { sourceID: best.sourceID, kind: best.kind, snapshot: best.snapshot }
  }

  return {
    /** 连接建立（来源→宿主第一条消息）。旧代次的迟到注册被拒绝。 */
    register(sourceID: string, kind: PetSourceKind, generation: number): "ok" | "stale" {
      const existing = sources.get(sourceID)
      if (existing && existing.generation > generation) return "stale"
      sources.set(sourceID, { sourceID, kind, generation, sequence: 0, snapshot: null, activationOrder: 0, connected: false })
      changed()
      return "ok"
    },

    /** SSE 事件流已挂上 = 来源进程确认存活。 */
    attach(sourceID: string): boolean {
      const source = sources.get(sourceID)
      if (!source) return false
      source.connected = true
      changed()
      return true
    },

    /** 连接断开（SSE close：正常退出漏发 release、崩溃、终端被杀）。 */
    detach(sourceID: string): void {
      const source = sources.get(sourceID)
      if (!source?.connected) return
      source.connected = false
      changed()
    },

    /** 显式激活接管。旧代次拒绝；同代次刷新激活顺序。 */
    activate(sourceID: string, generation: number): boolean {
      const source = sources.get(sourceID)
      if (!source || source.generation !== generation) return false
      source.activationOrder = ++activationOrder
      deps.onActivate?.(sourceID)
      changed()
      return true
    },

    /** 快照推送。仅接受当前代次且序号单调递增的消息。 */
    snapshot(sourceID: string, generation: number, sequence: number, snapshot: DesktopPetSnapshot | null): boolean {
      const source = sources.get(sourceID)
      if (!source || source.generation !== generation) return false
      if (!Number.isSafeInteger(sequence) || sequence <= source.sequence) return false
      source.sequence = sequence
      source.snapshot = snapshot
      changed()
      return true
    },

    /** 显式释放（正常退出）。 */
    release(sourceID: string): void {
      if (!sources.has(sourceID)) return
      sources.delete(sourceID)
      changed()
    },

    active(): PetActiveDisplay | undefined {
      return pickActive()
    },

    connectedCount(): number {
      let count = 0
      for (const source of sources.values()) if (source.connected) count++
      return count
    },

    sources(): RegistrySource[] {
      return [...sources.values()]
    },
  }
}
