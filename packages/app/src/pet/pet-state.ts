/**
 * Pet System 状态核心：真实引擎事件 → PetState 归一化。
 *
 * 事件源对照：E:\AI\dsh-pet\PET_EVENT_SOURCE_MAPPING.md（@8c7ee139 实测）。
 * 设计原则（REDCode_PET_SYSTEM_DESIGN.md #31）：Pet 不参与推理、不污染 Conversation、
 * 状态零持久化（进程内存态、重启归零）、终态必须超时回落（dsh-pet issue #59 教训）。
 *
 * 260929 Red 事件源换血：原订阅的 session.next.tool.* / reasoning.started /
 * compaction.* 属于 EventV2 双写体系，发布者已在 688c31cf（摘除双写）整体移除——
 * 有定义、有投影、无发布，coding/searching/tool/compacting/success 五态实际永不触发。
 * 现全部改走活流：
 *   message.part.updated（part 自带 sessionID；ToolPart state.status 为
 *                        pending/running/completed/error，另有 compaction part）
 *   session.status / session.compacted / permission.* / question.* / session.error
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
  /**
   * 260929 Red 回合内是否动过工具——success flash 的判据（busy 时重置、idle 时消费）。
   * 旧实现看「idle 时最后一个 activity 是不是工具型」：工具完成后 entry 已回 thinking，
   * 正常干完活的回合永远庆祝不了，只有被打断的回合才庆祝——判据本身就是反的。
   */
  worked: Record<string, boolean | undefined>
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
  return { sessions: {}, worked: {}, flash: undefined }
}

export type PetEvent = { type: string; properties?: unknown }

/** 工具名 → 展示分类。命中不了的归 tool（操作终端类）。词边界防 todowrite 被write 误吞。 */
export function classifyTool(tool: string): "coding" | "searching" | "tool" {
  const name = tool.toLowerCase()
  if (/\b(edit|write|patch|notebook|apply)\b/.test(name)) return "coding"
  if (/(grep|glob|search|find|list|ls|read|fetch|web|query)/.test(name)) return "searching"
  return "tool"
}

/** message.part.updated 的 part（只取 Pet 用得到的字段；其余 part 类型走 default 忽略）。 */
type PetPart = {
  sessionID?: string
  type?: string
  tool?: string
  state?: { status?: string }
}

type SessionProps = {
  sessionID?: string
  status?: { type?: string }
  part?: PetPart
}

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
  let best: PetActivity | undefined
  for (const activity of Object.values(state.sessions)) {
    if (!activity) continue
    if (entryExpired(activity, now)) continue
    if (!best || PRIORITY[activity.kind]! > PRIORITY[best.kind]!) best = activity
  }
  // 260929 Red 用户交互压过 flash：旧实现第一行就 return flash，error flash 的 5 秒窗口内
  // 到来的 permission/question 会被整段盖住——而「需要你允许一下」恰是最不能错过的提醒。
  if (best && (best.kind === "permission" || best.kind === "waiting")) return { kind: best.kind }
  if (flashActive(state.flash, now)) return { kind: state.flash!.kind }
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
 * 清理过期 entry。
 *
 * 260929 Red resolvePet 对过期 entry 只 `continue` 不删，state.sessions 于是只增不减——
 * 流中断、切走后再也不发 idle 的会话会永久留下一条记录，且每次 resolvePet 都要全量遍历
 * 它们。改 resolvePet 成会删状态的读函数不行（它是 createMemo 里的纯投影），所以在唯一
 * 的写入点 applyPetEvent 开头顺手扫一遍：事件频率足够高，成本是 O(会话数)。
 *
 * worked 一起删——它同样只在 idle/error 时清，entry 过期说明这一轮的下场没人知道，
 * 留着会在下一次 busy 时被当成「本回合用过工具」。
 */
function pruneStale(state: PetState, now: number): void {
  for (const [id, activity] of Object.entries(state.sessions)) {
    if (activity && entryExpired(activity, now)) {
      delete state.sessions[id]
      delete state.worked[id]
    }
  }
}

/**
 * 事件归一化。直接原地修改 state（调用方持有 store 时套 produce）。
 *
 * 状态迁移原则（260929 Red 起只认活事件，见文件头）：
 * - message.part.updated：tool part pending/running 按工具名分类；completed/error 记 worked
 *   并回 thinking（agent 继续生成）；compaction part 进 compacting；text/reasoning 兜底 thinking
 * - session.status busy/retry：**新回合**开张时复位 worked，无 entry 时兜底 thinking
 *   （同一回合内后续 step 的 busy 不再复位，见下方注释）
 * - session.status idle：清 entry；本回合动过工具（worked）才触发 success flash——纯问答不庆祝
 * - permission/question 等用户交互事件替换当前 entry，回应后回 thinking（会话仍 busy）
 * - session.error 触发 error flash 并清 entry（错误通常伴随回合终止）
 */
export function applyPetEvent(state: PetState, event: PetEvent, now: number): void {
  pruneStale(state, now)
  const props = (event.properties ?? {}) as SessionProps
  const sessionID = props.sessionID
  const setEntry = (activity: PetActivity) => {
    if (!sessionID) return
    state.sessions[sessionID] = activity
  }

  switch (event.type) {
   case "message.part.updated": {
     // 260929 Red 注意：sessionID 在 part 上而不是 properties 顶层，必须用 id 归属会话——
     // 用外层 setEntry（抓 props.sessionID）会整个静默跳过。
     const part = props.part
     const id = part?.sessionID
     if (!part || !id) return
     const setEntryByPart = (activity: PetActivity) => {
       state.sessions[id] = activity
     }
     switch (part.type) {
       case "tool": {
         const status = part.state?.status
         if (status === "completed" || status === "error") {
           state.worked[id] = true
           setEntryByPart({ kind: "thinking", at: now })
           return
         }
         // pending / running（状态缺失也按运行中展示：宁可多动，不可假死）
         const tool = part.tool ?? ""
         setEntryByPart({ kind: classifyTool(tool), tool, at: now })
         return
       }
       case "compaction":
         setEntryByPart({ kind: "compacting", at: now })
         return
       case "reasoning":
       case "text":
         // 模型在产出；已有更具体的 entry（工具/压缩中）时不覆盖
         if (!state.sessions[id]) setEntryByPart({ kind: "thinking", at: now })
         return
       default:
         return
     }
    }
    case "session.status": {
      if (!sessionID) return
      const status = props.status?.type
      if (status === "idle") {
        delete state.sessions[sessionID]
        if (state.worked[sessionID]) state.flash = { kind: "success", at: now }
        delete state.worked[sessionID]
        return
      }
      // busy / retry：无 entry 时兜底 thinking（retry 也是 agent 在努力）
      // 260929 Red worked 只在**新回合**开张时复位。agent loop 每个 step 顶部都发 busy
      // （session/prompt.ts:1138 那条 status.set 在 while(true) 里），旧实现无条件
      // worked=false，于是「第一步用工具、第二步只剩纯文本」的多步回合到 idle 时
      // 庆祝不了——agent 明明干了活。idle 会删 entry，所以「没有 entry」正是
      // idle→busy 的那条边沿；error 也删 entry，重试同样算新回合。
      if (!state.sessions[sessionID]) {
        state.worked[sessionID] = false
        setEntry({ kind: "thinking", at: now })
      }
      return
    }
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
      if (sessionID) {
        delete state.sessions[sessionID]
        delete state.worked[sessionID]
      }
      return
    }
    default:
      return
  }
}
