import type { DesktopPetSnapshot } from "./desktop-pet"

// 261119 Red TUI/GUI 共用桌面桌宠的宿主协议契约：来源注册、快照信封、本机登记文件。
// 产品边界与已定决策 → docs/notes/proposed/feature/2026-11-18-tui-shared-desktop-pet.md。
// 本模块是 desktop（宿主/写）与 redspace（来源/读）的唯一共享契约面；校验风格照
// pet-geometry.ts 的 savedPetPoint——手写、返回 undefined 表示无效，不抛错。

/** 协议版本：宿主与登记文件、来源消息共用；不匹配即拒绝，不做兼容翻译。 */
export const PET_HOST_PROTOCOL = 1

/** 快照/标签在进程边界的长度上限（进程边界只做形状校验，语义规则仍在 pet-state）。 */
const LABEL_MAX = 64
const OUTFIT_MAX = 64
const SOURCE_ID_MAX = 64
const PATH_MAX = 4096
/** behavior 数值字段的边界（毫秒/概率），防止来源推 0 或负值让渲染层忙死。 */
const BEHAVIOR_MAX_MS = 3_600_000

export type PetSourceKind = "gui" | "tui"

/** 来源→宿主：连接后第一条消息，声明来源身份与连接代次。 */
export type PetSourceRegistration = {
  type: "register"
  sourceID: string
  kind: PetSourceKind
  generation: number
}

/** 来源→宿主：快照推送（sequence 单调递增，宿主丢弃过期序号）。 */
export type PetSourceSnapshotMessage = {
  type: "snapshot"
  generation: number
  sequence: number
  snapshot: DesktopPetSnapshot | null
}

/** 来源→宿主：显式激活接管（GUI 窗口焦点/切会话、TUI 启动/切会话）。 */
export type PetSourceActivateMessage = {
  type: "activate"
  generation: number
}

/** 来源→宿主：显式释放（正常退出；断连由宿主按连接关闭兜底）。 */
export type PetSourceReleaseMessage = {
  type: "release"
}

export type PetSourceMessage =
  | PetSourceRegistration
  | PetSourceSnapshotMessage
  | PetSourceActivateMessage
  | PetSourceReleaseMessage

/** 宿主→来源：SSE 推送。closed = 用户点了赤的关闭按钮（只关本次显示，不改持久开关）。 */
export type PetHostEvent = { type: "closed" }

/** `~/.redcode/state/pet-host.json`：运行中的宿主登记（宿主启动时写、退出时删）。 */
export type PetHostFile = {
  protocol: number
  pid: number
  port: number
  token: string
  version: string
  startedAt: number
}

/** `~/.redcode/state/pet-host-install.json`：宿主 spawn 命令登记（桌面版每次启动写；桌面版不在时来源据此提示）。 */
export type PetHostInstallFile = {
  protocol: number
  version: string
  command: string[]
}

const KIND_SCALARS = new Set(["idle", "unknown", "thinking", "compacting", "success", "error"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

/** 校验跨进程快照：kind 枚举（含 tool 对象形态）、outfit/标签长度、behavior 数值有界。 */
export function validatePetSnapshot(raw: unknown): DesktopPetSnapshot | null | undefined {
  if (raw === null) return null
  if (!isRecord(raw)) return undefined
  const { kind, outfit, behavior } = raw as { kind: unknown; outfit: unknown; behavior: unknown }
  if (typeof kind === "string") {
    if (!KIND_SCALARS.has(kind)) return undefined
  } else if (isRecord(kind)) {
    const tool = kind.kind === "coding" || kind.kind === "searching" || kind.kind === "tool"
    const asked = kind.kind === "waiting" || kind.kind === "permission"
    if (!tool && !asked) return undefined
    if (tool && !boundedString(kind.tool, LABEL_MAX)) return undefined
    if (asked && kind.detail !== undefined && !boundedString(kind.detail, LABEL_MAX)) return undefined
  } else {
    return undefined
  }
  if (!boundedString(outfit, OUTFIT_MAX)) return undefined
  if (!isRecord(behavior)) return undefined
  const fields = Object.keys(behavior)
  if (fields.length !== 9) return undefined
  for (const field of fields) {
    const value = behavior[field]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > BEHAVIOR_MAX_MS) return undefined
  }
  return raw as unknown as DesktopPetSnapshot
}

/** 校验来源注册/消息信封的公共字段；具体消息类型由宿主按 type 分派后再校验。 */
export function validateSourceID(value: unknown): value is string {
  return boundedString(value, SOURCE_ID_MAX) && /^[A-Za-z0-9_-]+$/.test(value)
}

export function validateGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** 校验运行中的宿主登记文件（来源读取入口）。version/pid 只作诊断，不做信任判据。 */
export function validatePetHostFile(raw: unknown): PetHostFile | undefined {
  if (!isRecord(raw)) return undefined
  const { protocol, pid, port, token, version, startedAt } = raw as Record<string, unknown>
  if (protocol !== PET_HOST_PROTOCOL) return undefined
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port <= 0 || port > 65535) return undefined
  if (!boundedString(token, 128)) return undefined
  if (!boundedString(version, LABEL_MAX)) return undefined
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt)) return undefined
  return { protocol, pid, port, token, version, startedAt }
}

/** 校验宿主 spawn 命令登记文件。command 是完整 argv（可执行文件 + 参数），来源按原样 spawn。 */
export function validatePetInstallFile(raw: unknown): PetHostInstallFile | undefined {
  if (!isRecord(raw)) return undefined
  const { protocol, version, command } = raw as Record<string, unknown>
  if (protocol !== PET_HOST_PROTOCOL) return undefined
  if (!boundedString(version, LABEL_MAX)) return undefined
  if (!Array.isArray(command) || command.length < 1 || command.length > 8) return undefined
  for (const part of command) {
    if (!boundedString(part, PATH_MAX)) return undefined
  }
  return { protocol, version, command: [...command] }
}
