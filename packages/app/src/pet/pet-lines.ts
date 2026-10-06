import type { PetDisplay } from "./pet-state"

/**
 * V0.2 台词池与表现层调度（零 SolidJS 依赖，照 pet-state 惯例可测）。
 *
 * 克制原则（设计文档 #15）不变：permission/waiting/终态必说（不能错过的提醒），
 * 干活中的台词是低频碎碎念（换姿态时概率冒一句 + 冷却），idle 不主动说话、
 * 只有闲时动作（pet-layer 的调度器）才捎带一句。
 *
 * 261006 Red 只维护本地展示，不向引擎发送事件或生成模型消息。
 * 决策：docs/notes/implemented/feature/2026-10-06-pet-v02-presentation.md。
 */
export const LINES: Record<PetDisplay["kind"], string[]> = {
  idle: ["在呢", "…", "随时开工", "今天也加油"],
  thinking: ["让我想想…", "嗯，思路有了", "捋一下这里", "这个有点意思"],
  coding: ["在写了在写了", "改这里…", "敲键盘中", "几行的事"],
  searching: ["找找看", "翻一翻…", "不在这份，换一份", "有线索了"],
  tool: ["跑个命令", "很快的", "等它出结果"],
  waiting: ["等你回复…", "听着呢，说吧"],
  permission: ["这里需要你允许一下。", "借我点一下允许～"],
  compacting: ["东西太多了……压一压", "装箱中，忍一下"],
  success: ["搞定～", "收工！", "好了，你看看"],
  error: ["出错了……", "没成功，再试一次", "柠檬 +1"],
}

/** 闲时动作：coffee 用 02-idle-coffee.png（260929 审计孤儿素材收编），chatter 只冒一句。 */
export type IdleAction = "coffee" | "chatter"

export const IDLE_ACTION_LINES: Record<IdleAction, string[]> = {
  coffee: ["咖啡休息～", "（嘬一口）", "充个电"],
  chatter: ["…", "记得喝水", "安静得能听见键盘声", "随时待命"],
}

export type PetBehavior = {
  activityChatterChance: number
  chatterCooldownMs: number
  chatterMs: number
  idleIntervalMs: number
  idleActionChance: number
  idleActionMs: number
  coffeeChance: number
}

// 261006 Red settings.v3 的 general.petBehavior 可覆写；默认值由设置拥有方显式解析。
export function resolvePetBehavior(input: Partial<PetBehavior> = {}): PetBehavior {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid general.petBehavior: expected an object")
  const defaults: PetBehavior = {
    activityChatterChance: 0.3,
    chatterCooldownMs: 45_000,
    chatterMs: 6_000,
    idleIntervalMs: 25_000,
    idleActionChance: 0.4,
    idleActionMs: 5_000,
    coffeeChance: 0.5,
  }
  for (const key of Object.keys(input))
    if (!Object.hasOwn(defaults, key)) throw new Error(`Invalid general.petBehavior.${key}: unknown field`)
  const result = { ...defaults, ...input }
  for (const [key, value] of Object.entries(result)) {
    // 概率遵循 [0,1]；时长至少覆盖一次 1s 展示 tick，至多一天，避免无界等待。
    const probability = key.endsWith("Chance")
    if (!Number.isFinite(value) || value < (probability ? 0 : 1_000) || value > (probability ? 1 : 86_400_000))
      throw new Error(`Invalid general.petBehavior.${key}: ${value}`)
  }
  return result
}

/**
 * 从池里挑一句，尽量避开上一句（池 >1 时）；rand 可注入以便测试。
 */
export function pickLine(pool: string[], rand: () => number = Math.random, avoid?: string): string {
  const candidates = pool.length > 1 && avoid ? pool.filter((line) => line !== avoid) : pool
  return candidates[Math.floor(rand() * candidates.length)] ?? pool[0]!
}

/**
 * 换姿态时该不该说话：必说姿态恒 true；干活姿态掷概率（调用方再叠冷却）。
 */
export function shouldChatter(kind: PetDisplay["kind"], chance: number, rand: () => number = Math.random): boolean {
  if (kind === "permission" || kind === "waiting" || kind === "success" || kind === "error") return true
  if (kind === "idle") return false
  return rand() < chance
}

export type PetPresentation = {
  enabled: boolean
  kind: PetDisplay["kind"]
  line: { text: string; until?: number } | undefined
  action: IdleAction | undefined
  actionUntil: number | undefined
  idleDue: number | undefined
  lastLine: string
  lastChatterAt: number | undefined
}

export function createPetPresentation(): PetPresentation {
  return {
    enabled: false,
    kind: "idle",
    line: undefined,
    action: undefined,
    actionUntil: undefined,
    idleDue: undefined,
    lastLine: "",
    lastChatterAt: undefined,
  }
}

// 261006 Red 同姿态的心跳不重新抽词；闲时必须连续停留，工作/关闭均立即取消动作。
// 调用方用既有 1s tick 推进期限，没有额外 interval 或迟到 timeout 能覆盖新状态。
export function advancePetPresentation(
  state: PetPresentation,
  kind: PetDisplay["kind"],
  enabled: boolean,
  now: number,
  behavior: PetBehavior,
  rand: () => number = Math.random,
): void {
  const changed = state.kind !== kind || state.enabled !== enabled
  state.kind = kind
  state.enabled = enabled
  if (!enabled || changed) {
    state.line = undefined
    state.action = undefined
    state.actionUntil = undefined
    state.idleDue = enabled && kind === "idle" ? now + behavior.idleIntervalMs : undefined
  }
  if (!enabled) return

  if (changed && kind !== "idle") {
    const sticky = kind === "permission" || kind === "waiting" || kind === "success" || kind === "error"
    const cooled = state.lastChatterAt === undefined || now - state.lastChatterAt >= behavior.chatterCooldownMs
    if (sticky || (cooled && shouldChatter(kind, behavior.activityChatterChance, rand))) {
      state.lastLine = pickLine(LINES[kind], rand, state.lastLine)
      state.lastChatterAt = now
      state.line = sticky ? { text: state.lastLine } : { text: state.lastLine, until: now + behavior.chatterMs }
    }
  }

  if (state.line?.until !== undefined && now >= state.line.until) state.line = undefined
  if (state.actionUntil !== undefined && now >= state.actionUntil) {
    state.action = undefined
    state.actionUntil = undefined
  }
  if (kind !== "idle" || state.action || state.idleDue === undefined || now < state.idleDue) return
  state.idleDue = now + behavior.idleIntervalMs
  if (rand() >= behavior.idleActionChance) return
  state.action = rand() < behavior.coffeeChance ? "coffee" : "chatter"
  state.lastLine = pickLine(IDLE_ACTION_LINES[state.action], rand, state.lastLine)
  state.lastChatterAt = now
  state.actionUntil = now + behavior.idleActionMs
  state.line = { text: state.lastLine, until: state.actionUntil }
}
