import type {
  Agent,
  Command,
  Config,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
  Goal,
  VcsInfo,
} from "@redcode-ai/sdk/v2/client"
import { NormalizedProviderListResponse } from "@redcode-ai/ui/context"
import type { Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  // 260605 Red agent 列表由 bootstrap slow 批次异步填充，加就绪信号供 submit gate 统一判断
  agent_ready: boolean
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider_ready: boolean
  provider: NormalizedProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_working(id: string): boolean
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  // 260904 cc 这个会话的内存消息缓存被 MAX_MESSAGES_PER_SESSION 截断过（见 event-reducer）。
  // 分页层的 cursor/complete 记的是「服务端给过什么」，不知道内存里被砍过——不标这一笔，
  // 一个已经拉全（complete=true）的会话在流式跑过 100 条之后，history.more() 会一口咬定
  // 「没有更多」，被砍掉的历史就再也拉不回来了。
  message_trimmed: {
    [sessionID: string]: boolean
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  // 260820 cc 钉住的目标。一个会话至多一个，没钉时整条不存在（服务端 404）
  goal: {
    [sessionID: string]: Goal | undefined
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  mcp_ready: boolean
  mcp: {
    [name: string]: McpStatus
  }
  lsp_ready: boolean
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta: {
    [partID: string]: string
  }
}

export type VcsCache = {
  store: Store<{ value: VcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: VcsInfo | undefined }>
  ready: Accessor<boolean>
}

export type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

export type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

export type ChildOptions = {
  bootstrap?: boolean
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  ttl: number
  now: number
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}

export type RootLoadArgs = {
  directory: string
  limit: number
  list: (query: { directory: string; roots: true; limit?: number }) => Promise<{ data?: Session[] }>
}

export type RootLoadResult = {
  data?: Session[]
  limit: number
  limited: boolean
}

// 261011 Red 目录数硬上限退场（261009 曾调 30→10 控内存乘数）：活跃目录的硬性
// 淘汰不可执行——首页 Kanban 对全部项目建 store，淘了立即被视图重建，纯空转且
// 每轮重发 /instance/dispose（261011 现场见 eviction.ts）。收敛改由 idle TTL
// （DIR_IDLE_TTL_MS，闲置回收 + dispose）承担，乘数同理受控：活跃目录虽可多于
// 10 个，但每个 store 自身有界（session 64 / 消息窗口 400 条）。
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_RECENT_WINDOW = 4 * 60 * 60 * 1000
export const SESSION_RECENT_LIMIT = 50
