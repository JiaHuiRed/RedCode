/**
 * Pet System 状态核心：真实引擎事件 → PetState 归一化。
 *
 * 事件源对照：E:\AI\dsh-pet\PET_EVENT_SOURCE_MAPPING.md（@8c7ee139 实测）。
 * 设计原则（REDCode_PET_SYSTEM_DESIGN.md #31）：Pet 不参与推理、不污染 Conversation、
 * 状态零持久化（进程内存态、重启归零）、终态必须超时回落（dsh-pet issue #59 教训）。
 *
 * 本文件保持零 SolidJS 依赖，便于纯函数测试。
 */

/** 单个会话的持续型活跃状态（挂在 sessionID 上，回合结束/超时即清）。 */
export type PetActivity =
  | { kind: "thinking"; at: number }
  | { kind: "coding"; tool: string; at: number }
  | { kind: "searching"; tool: string; at: number }
  | { kind: "tool"; tool: string; at: number }
  | { kind: "waiting"; at: number }
  | { kind: "permission"; at: number }
  | { kind: "compacting"; at: number }

/** 瞬时态：回合收尾的短动画，FLASH_MS 后自动回落 idle。 */
export type PetFlash = { kind: "success" | "error"; at: number }

export type PetState = {
  sessions: Record<string, PetActivity | undefined>
  flash: PetFlash | undefined
}

/** 聚合后对外展示的状态（PetLayer 消费）。 */
export type PetDisplay =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "coding"; tool: string }
  | { kind: "searching"; tool: string }
  | { kind: "tool"; tool: string }
  | { kind: "waiting" }
  | { kind: "permission" }
  | { kind: "compacting" }
  | { kind: "success" }
  | { kind: "error" }

export const FLASH_MS = 5_000
/** thinking/tool 型 entry 超时兜底：引擎事件链断了也能回落 idle（dsh-pet「永远卡在工作」教训）。 */
export const STALE_MS = 90_000
/** waiting/permission 是「等用户」，不超时；compacting 单独给更长上限。 */
export const COMPACTING_STALE_MS = 180_000

export function createPetState(): PetState {
  return { sessions: {}, flash: undefined }
}

export type PetEvent = { type: string; properties?: unknown }

/** 工具名 → 展示分类。命中不了的归 tool（操作终端类）。词边界防 todowrite 被write 误吞。 */
export function classifyTool(tool: string): "coding" | "searching" | "tool" {
  const name = tool.toLowerCase()
  if (/\b(edit|write|patch|notebook|apply)\b/.test(name)) return "coding"
  if (/(grep|glob|search|find|list|ls|read|fetch|web|query)/.test(name)) return "searching"
  return "tool"
}

type SessionProps = { sessionID?: string }

function activityKind(activity: PetActivity): PetDisplay["kind"] {
  return activity.kind
}

/** 展示优先级，数值越大越优先。permission 最高（设计文档 #8：最值得优先做的提醒）。 */
const PRIORITY: Record<string, number> = {
  permission: 70,
  waiting: 60,
  compacting: 50,
  coding: 40,
  searching: 40,
  tool: 40,
  thinking: 30,
}

function entryExpired(activity: PetActivity, now: number): boolean {
  if (activity.kind === "waiting" || activity.kind === "permission") return false
  const limit = activity.kind === "compacting" ? COMPACTING_STALE_MS : STALE_MS
  return now - activity.at > limit
}

function flashActive(flash: PetFlash | undefined, now: number): boolean {
  return flash !== undefined && now - flash.at <= FLASH_MS
}

/**
 * 聚合所有会话 → 单一展示态。
 * 会话级视角（赤 = Agent 本体的化身）：任一会话的最高优先级活动就是赤的当前状态。
 */
export function resolvePet(state: PetState, now: number): PetDisplay {
  if (flashActive(state.flash, now)) return { kind: state.flash!.kind }

  let best: PetActivity | undefined
  for (const activity of Object.values(state.sessions)) {
    if (!activity) continue
    if (entryExpired(activity, now)) continue
    if (!best || PRIORITY[activity.kind]! > PRIORITY[best.kind]!) best = activity
  }
  if (best) {
    const kind = activityKind(best)
    if (kind === "coding" || kind === "searching" || kind === "tool") {
      return { kind, tool: (best as { tool: string }).tool }
    }
    return { kind }
  }
  return { kind: "idle" }
}

/**
 * 事件归一化。直接原地修改 state（调用方持有 store 时套 produce）。
 *
 * 状态迁移原则：
 * - tool.called 覆盖 thinking；tool.success/failed 回 thinking（agent 继续生成文本）
 * - permission/question 等用户交互事件替换当前 entry，回应后回 thinking（会话仍 busy）
 * - status idle 清 entry；若刚才是工具型活动，触发 success flash（干完活才庆祝，纯问答不庆祝）
 * - session.error 触发 error flash 并清 entry（错误通常伴随回合终止）
 */
export function applyPetEvent(state: PetState, event: PetEvent, now: number): void {
  const props = (event.properties ?? {}) as SessionProps
  const sessionID = props.sessionID
  const setEntry = (activity: PetActivity) => {
    if (!sessionID) return
    state.sessions[sessionID] = activity
  }

  switch (event.type) {
    case "session.status": {
      if (!sessionID) return
      const status = (props as { status?: { type?: string } }).status?.type
      if (status === "idle") {
        const prev = state.sessions[sessionID]
        delete state.sessions[sessionID]
        if (prev && (prev.kind === "coding" || prev.kind === "searching" || prev.kind === "tool")) {
          state.flash = { kind: "success", at: now }
        }
        return
      }
      // busy / retry：无 entry 时兜底 thinking（retry 也是 agent 在努力）
      const current = state.sessions[sessionID]
      if (!current) setEntry({ kind: "thinking", at: now })
      return
    }
    case "session.next.reasoning.started":
      setEntry({ kind: "thinking", at: now })
      return
    case "session.next.tool.called": {
      const tool = (props as { tool?: string }).tool ?? ""
      setEntry({ kind: classifyTool(tool), tool, at: now })
      return
    }
    case "session.next.tool.success":
    case "session.next.tool.failed":
      // 回到生成态；失败不直接 error（agent 通常会自恢复，连续失败由 session.error 兜底）
      setEntry({ kind: "thinking", at: now })
      return
    case "session.next.compaction.started":
      setEntry({ kind: "compacting", at: now })
      return
    case "session.next.compaction.ended":
    case "session.compacted":
      setEntry({ kind: "thinking", at: now })
      return
    case "permission.asked":
      setEntry({ kind: "permission", at: now })
      return
    case "permission.replied":
      setEntry({ kind: "thinking", at: now })
      return
    case "question.asked":
      setEntry({ kind: "waiting", at: now })
      return
    case "question.replied":
    case "question.rejected":
      setEntry({ kind: "thinking", at: now })
      return
    case "session.error": {
      state.flash = { kind: "error", at: now }
      if (sessionID) delete state.sessions[sessionID]
      return
    }
    default:
      return
  }
}
