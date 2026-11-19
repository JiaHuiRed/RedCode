/**
 * Pet System 状态核心：真实引擎事件 → PetState 归一化。
 *
 * 事件源对照：docs/notes/implemented/feature/2026-10-06-pet-v02-presentation.md、
 * docs/notes/implemented/feature/2026-10-01-pet-stream-heartbeat-winner.md。
 * 装扮桥接：获胜 sessionID → 会话 model → providerID outfit（决策见
 * docs/notes/implemented/feature/2026-10-15-pet-outfit-bridging.md）。
 * 设计原则（`REDCode_PET_SYSTEM_DESIGN.md` #31——**该文档不在本仓**，注释所称路径在另一台机的
 * `E:\AI\dsh-pet\`，本机未见；本地记录只有上面三篇 note）：Pet 不参与推理、不污染 Conversation、
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
  | { kind: "waiting"; at: number; detail?: string }
  | { kind: "permission"; at: number; detail?: string }
  | { kind: "compacting"; at: number }

/** 瞬时态：回合收尾的短动画，FLASH_MS 后自动回落 idle。 */
export type PetFlash = { kind: "success" | "error"; at: number; sessionID?: string; directory?: string }

export type PetState = {
  sessions: Record<string, PetActivity | undefined>
  /**
   * 260929 Red 回合内是否动过工具——success flash 的判据（busy 时重置、idle 时消费）。
   * 旧实现看「idle 时最后一个 activity 是不是工具型」：工具完成后 entry 已回 thinking，
   * 正常干完活的回合永远庆祝不了，只有被打断的回合才庆祝——判据本身就是反的。
   */
  worked: Record<string, boolean | undefined>
  models: Record<string, { providerID: string; modelID: string } | undefined>
  blockers: Record<string, Record<string, Extract<PetActivity, { kind: "waiting" | "permission" }>> | undefined>
  owners: Record<string, string | undefined>
  bootstraps: Record<string, Record<string, PetEvent> | undefined>
  flash: PetFlash | undefined
}

/** 聚合后对外展示的状态（PetLayer 消费）。 */
type PetDisplayBase =
  | { kind: "idle" }
  | { kind: "unknown" }
  | { kind: "thinking" }
  | { kind: "coding"; tool: string }
  | { kind: "searching"; tool: string }
  | { kind: "tool"; tool: string }
  | { kind: "waiting"; detail?: string }
  | { kind: "permission"; detail?: string }
  | { kind: "compacting" }
  | { kind: "success" }
  | { kind: "error" }

export type PetDisplay = PetDisplayBase & {
  /** 260930 Red 获胜会话：表现层按它取模型上下文；全局视角的 flash 和 idle 不带归属。 */
  sessionID?: string
}

export const FLASH_MS = 5_000
export const DEFAULT_OUTFIT = "default"
/** thinking/tool 型 entry 超时兜底：引擎事件链断了也能回落 idle（dsh-pet「永远卡在工作」教训）。 */
export const STALE_MS = 90_000
/** waiting/permission 是「等用户」，不超时；compacting 单独给更长上限。 */
export const COMPACTING_STALE_MS = 180_000

export function createPetState(): PetState {
  return { sessions: {}, worked: {}, models: {}, blockers: {}, owners: {}, bootstraps: {}, flash: undefined }
}

export function outfitFor(state: PetState, sessionID: string | undefined): string {
  return (sessionID && state.models[sessionID]?.providerID) || DEFAULT_OUTFIT
}

export type PetEvent = { type: string; properties?: unknown }

// 261031 Red 仅在目录 bootstrap 在途时保留事件覆盖，提交后交还 child store。
export function beginPetBootstrap(state: PetState, directory: string): void {
  state.bootstraps[directory] = {}
  if (state.flash?.directory === directory) state.flash = undefined
  for (const [id, owner] of Object.entries(state.owners)) {
    if (owner !== directory) continue
    delete state.sessions[id]
    delete state.worked[id]
    delete state.models[id]
    delete state.blockers[id]
    delete state.owners[id]
  }
}

export function recordPetBootstrapEvent(state: PetState, directory: string, event: PetEvent): void {
  const journal = state.bootstraps[directory]
  if (!journal) return
  const props = (event.properties ?? {}) as SessionProps
  if (!props.sessionID) return
  const kind = event.type === "permission.asked" || event.type === "permission.replied" ? "permission" :
    event.type === "question.asked" || event.type === "question.replied" || event.type === "question.rejected" ? "question" : undefined
  const request = event.type.endsWith(".asked") ? props.id : props.requestID
  const key = event.type === "session.status" ? `status:${props.sessionID}` :
    kind && request ? `${kind}:${props.sessionID}:${request}` : undefined
  if (!key) return
  delete journal[key]
  journal[key] = event
}

export function finishPetBootstrap(state: PetState, directory: string): PetEvent[] {
  const events = Object.values(state.bootstraps[directory] ?? {})
  delete state.bootstraps[directory]
  return events
}
// 261031 Red 分区清算：快照写入完成（onSnapshot）时，把该分区 journal 事件交还给 child
// reducer 按序重放——快照可能比窗口内已到达的事件旧（HTTP 往返间隙事件穿过），直接 reconcile
// 会复活已回复的请求或覆盖更新的状态。asked/replied/status 的 child 处理都是幂等确定性操作
// （按 id 二分插入/删除、整条 reconcile），重放净效果 = 事件流最终态。status 重放安全性穷举：
// journal 最后一条 status 要么晚于快照生成时刻（重放即修正），要么其后的实时事件会再覆盖 store。
export function settlePetBootstrap(state: PetState, directory: string, kind: "permission" | "question" | "session.status"): PetEvent[] {
 const journal = state.bootstraps[directory]
 if (!journal) return []
 const prefix = kind === "session.status" ? "status:" : `${kind}:`
 const events: PetEvent[] = []
 for (const [key, event] of Object.entries(journal)) {
   if (!key.startsWith(prefix)) continue
   delete journal[key]
   events.push(event)
 }
 return events
}

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
  id?: string
  requestID?: string
  permission?: string
  questions?: { header?: string; question?: string }[]
  status?: { type?: string }
  part?: PetPart
  info?: {
    sessionID?: string
    model?: { providerID: string; modelID: string }
  }
}

// 261031 Red 展示仅接受短标签；路径、命令、长标识和疑似凭据不进入气泡。
export function safeLabel(value: unknown, title = false): string | undefined {
  if (typeof value !== "string" || !value || value.length > (title ? 30 : 64)) return
  if (title) {
    if (/[/\\\r\n?？=:]|(?:token|secret|password|api.?key|密码|密钥)/i.test(value)) return
    if (/[A-Za-z0-9_-]{16,}/.test(value)) return
    return value.trim() || undefined
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) return
  if (/(?:token|secret|password|api.?key)/i.test(value)) return
  return value
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
  let bestSession: string | undefined
  for (const [id, activity] of Object.entries(state.sessions)) {
    if (!activity) continue
    if (entryExpired(activity, now)) continue
    if (!best || PRIORITY[activity.kind]! > PRIORITY[best.kind]!) {
      best = activity
      bestSession = id
    }
  }
  for (const [id, entries] of Object.entries(state.blockers)) {
    for (const activity of Object.values(entries ?? {})) {
      if (!best || PRIORITY[activity.kind]! > PRIORITY[best.kind]!) {
        best = activity
        bestSession = id
      }
    }
  }
  // 260929 Red 用户交互压过 flash：旧实现第一行就 return flash，error flash 的 5 秒窗口内
  // 到来的 permission/question 会被整段盖住——而「需要你允许一下」恰是最不能错过的提醒。
  if (best && (best.kind === "permission" || best.kind === "waiting"))
    return { kind: best.kind, sessionID: bestSession, ...(best.detail ? { detail: best.detail } : {}) }
  if (flashActive(state.flash, now)) return { kind: state.flash!.kind }
  if (best) {
    const kind = activityKind(best)
    if (kind === "coding" || kind === "searching" || kind === "tool") {
      return { kind, tool: (best as { tool: string }).tool, sessionID: bestSession }
    }
    return { kind, sessionID: bestSession }
  }
  return { kind: "idle" }
}

export type PetSnapshot = {
  status?: { type: string }
  statusReady?: boolean
  permissions?: readonly { id: string; permission: string }[]
  questions?: readonly { id: string; questions: readonly { header: string; question: string }[] }[]
}

// 261031 Red 当前会话只投影自己的事件和目录快照；缺状态不等于 idle。
export function resolveSessionPet(state: PetState, now: number, sessionID: string, snapshot?: PetSnapshot, directory?: string): PetDisplay {
  const journal = directory ? state.bootstraps[directory] : undefined
  const permissions = snapshot?.permissions?.filter((item) =>
    !journal?.[`permission:${sessionID}:${item.id}`] || journal[`permission:${sessionID}:${item.id}`]?.type === "permission.asked") ?? []
  const questions = snapshot?.questions?.filter((item) =>
    !journal?.[`question:${sessionID}:${item.id}`] || journal[`question:${sessionID}:${item.id}`]?.type === "question.asked") ?? []
  const eventBlockers = Object.values(state.blockers[sessionID] ?? {})
  const permission = permissions[0]
  if (permission) {
    const detail = safeLabel(permission.permission)
    return { kind: "permission", sessionID, ...(detail ? { detail } : {}) }
  }
  const eventPermission = eventBlockers.find((item) => item.kind === "permission")
  if (eventPermission) return { kind: "permission", sessionID, ...(eventPermission.detail ? { detail: eventPermission.detail } : {}) }
  const question = questions[0]?.questions[0]
  if (questions.length) {
    const detail = question && question.header !== question.question ? safeLabel(question.header, true) : undefined
    return { kind: "waiting", sessionID, ...(detail ? { detail } : {}) }
  }
  const eventQuestion = eventBlockers.find((item) => item.kind === "waiting")
  if (eventQuestion) return { kind: "waiting", sessionID, ...(eventQuestion.detail ? { detail: eventQuestion.detail } : {}) }
  const activity = state.sessions[sessionID]
  if (flashActive(state.flash, now) && state.flash?.sessionID === sessionID &&
      (!activity || entryExpired(activity, now) || activity.at < state.flash.at))
    return { kind: state.flash.kind, sessionID }
  if (activity && !entryExpired(activity, now)) {
    if (activity.kind === "coding" || activity.kind === "searching" || activity.kind === "tool")
      return { kind: activity.kind, tool: activity.tool, sessionID }
    if (activity.kind === "permission" || activity.kind === "waiting")
      return { kind: activity.kind, sessionID, ...(activity.detail ? { detail: activity.detail } : {}) }
    return { kind: activity.kind, sessionID }
  }
  const status = (journal?.[`status:${sessionID}`]?.properties as SessionProps | undefined)?.status ?? snapshot?.status
  if (status?.type === "idle") return { kind: "idle", sessionID }
  if (status?.type === "busy" || status?.type === "retry")
    return { kind: "thinking", sessionID }
  if (!status && snapshot?.statusReady) return { kind: "idle", sessionID }
  return { kind: "unknown", sessionID }
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
      delete state.models[id]
      if (!state.blockers[id]) delete state.owners[id]
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
  const clearBlockers = (id: string) => {
    delete state.blockers[id]
  }
  const setEntry = (activity: PetActivity) => {
    if (!sessionID) return
    state.sessions[sessionID] = activity
  }

  switch (event.type) {
    case "message.updated": {
      const info = props.info
      if (info?.sessionID && info.model?.providerID) state.models[info.sessionID] = info.model
      return
    }
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
        case "text": {
          // 模型在产出；已有更具体的 entry（工具/压缩中/等用户）时不覆盖。
          // 260930 Red 已有 thinking entry 也要刷新——part.updated 是产出期的低频定型
          // 事件，只创建不刷新的话，长回合两次定型之间 entry 照样超时。
          const existing = state.sessions[id]
          if (!existing) setEntryByPart({ kind: "thinking", at: now })
          else if (existing.kind === "thinking") existing.at = now
          return
        }
        default:
          return
      }
    }
    case "message.part.delta": {
      // 260930 Red 流式心跳：产出期真正的高频事件是 delta（processor.ts 的 reasoning-delta/
      // text-delta），part.updated 只在 part 定型时才来——旧实现收不到心跳，长回复中途
      // entry 就 90s 超时被打回 idle。delta 的 properties 顶层自带 sessionID
      // （EventMessagePartDelta），O(1) 刷时间戳；渲染节奏在 PetLayer 的 1s tick，
      // 这里不触发任何动画。等用户（waiting/permission）与具体工具态不被心跳打扰。
      if (!sessionID) return
      const current = state.sessions[sessionID]
      if (!current) state.sessions[sessionID] = { kind: "thinking", at: now }
      else if (current.kind === "thinking") current.at = now
      return
    }
    case "session.status": {
      if (!sessionID) return
      const status = props.status?.type
      if (status === "idle") {
        delete state.sessions[sessionID]
        clearBlockers(sessionID)
        delete state.models[sessionID]
        if (state.worked[sessionID]) state.flash = { kind: "success", at: now, sessionID }
        delete state.worked[sessionID]
        return
      }
      // busy / retry：无 entry 时兜底 thinking（retry 也是 agent 在努力）
      // 260929 Red worked 只在**新回合**开张时复位。agent loop 每个 step 顶部都发 busy
      // （session/prompt.ts:1138 那条 status.set 在 while(true) 里），旧实现无条件
      // worked=false，于是「第一步用工具、第二步只剩纯文本」的多步回合到 idle 时
      // 庆祝不了——agent 明明干了活。idle 会删 entry，所以「没有 entry」正是
      // idle→busy 的那条边沿；error 也删 entry，重试同样算新回合。
      const current = state.sessions[sessionID]
      if (!current) {
        state.worked[sessionID] = false
        setEntry({ kind: "thinking", at: now })
      } else if (current.kind === "thinking") {
        // 260930 Red 后续 step 的 busy 同样是活动：刷新 thinking 心跳（worked 复位仍只在新回合）。
        current.at = now
      }
      return
    }
    case "session.compacted":
      setEntry({ kind: "thinking", at: now })
      return
    case "permission.asked":
    case "question.asked": {
      if (!sessionID) return
      const kind = event.type === "permission.asked" ? "permission" : "waiting"
      const question = props.questions?.[0]
      const detail = kind === "permission"
        ? safeLabel(props.permission)
        : question?.header !== question?.question ? safeLabel(question?.header, true) : undefined
      const entries = state.blockers[sessionID] ?? (state.blockers[sessionID] = {})
      entries[`${kind}:${props.id ?? ""}`] = { kind, at: now, ...(detail ? { detail } : {}) }
      return
    }
    case "permission.replied":
    case "question.replied":
    case "question.rejected": {
      if (!sessionID) return
      const kind = event.type === "permission.replied" ? "permission" : "waiting"
      const entries = state.blockers[sessionID]
      if (entries) {
        delete entries[`${kind}:${props.requestID ?? ""}`]
        if (!Object.keys(entries).length) delete state.blockers[sessionID]
      }
      setEntry({ kind: "thinking", at: now })
      return
    }
    case "session.error": {
      state.flash = sessionID ? { kind: "error", at: now, sessionID } : { kind: "error", at: now }
      if (sessionID) {
        delete state.sessions[sessionID]
        delete state.worked[sessionID]
        delete state.models[sessionID]
        clearBlockers(sessionID)
      }
      return
    }
    default:
      return
  }
}
