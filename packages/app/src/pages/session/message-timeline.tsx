import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  mapArray,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { Accordion } from "@redcode-ai/ui/accordion"
import { Avatar } from "@redcode-ai/ui/avatar"
import { Button } from "@redcode-ai/ui/button"
import { Card } from "@redcode-ai/ui/card"
import {
  ContextToolGroup,
  Message,
  MessageDivider,
  Part as MessagePart,
  partDefaultOpen,
  formatReasoningDuration,
  type UserActions,
} from "@redcode-ai/ui/message-part"
import { DiffChanges } from "@redcode-ai/ui/diff-changes"
import { FileIcon } from "@redcode-ai/ui/file-icon"
import { Icon } from "@redcode-ai/ui/icon"
import { IconButton } from "@redcode-ai/ui/icon-button"
import { DropdownMenu } from "@redcode-ai/ui/dropdown-menu"
import { Dialog } from "@redcode-ai/ui/dialog"
import { InlineInput } from "@redcode-ai/ui/inline-input"
import { Spinner } from "@redcode-ai/ui/spinner"
import { SessionRetry } from "@redcode-ai/ui/session-retry"
import { ScrollView } from "@redcode-ai/ui/scroll-view"
import { StickyAccordionHeader } from "@redcode-ai/ui/sticky-accordion-header"
import { TextField } from "@redcode-ai/ui/text-field"
import { TextReveal } from "@redcode-ai/ui/text-reveal"
import { TextShimmer } from "@redcode-ai/ui/text-shimmer"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  ToolPart,
  UserMessage,
} from "@redcode-ai/sdk/v2"
import { showToast } from "@redcode-ai/ui/toast"
import { Binary } from "@redcode-ai/core/util/binary"
import { getDirectory, getFilename } from "@redcode-ai/core/util/path"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { normalize } from "@redcode-ai/ui/session-diff"
import { useFileComponent } from "@redcode-ai/ui/context/file"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLanguage } from "@/context/language"
import { useSessionKey } from "@/pages/session/session-layout"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { makeTimer } from "@solid-primitives/timer"
import { MessageComment, SummaryDiff, Timeline, TimelineRow, TimelineRowMap } from "./message-timeline.data"

const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyTools: ToolPart[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "BottomSpacer" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

function sameKeys(a: readonly string[] | undefined, b: readonly string[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((key, index) => key === b[index])
}

const timelineCacheLimit = 16
const timelineFallbackItemSize = 60
const timelineCache = new Map<string, { keys: readonly string[]; cache: VirtualizerHandle["cache"] }>()

function readTimelineCache(id: string, keys: readonly string[]) {
  const entry = timelineCache.get(id)
  if (!entry) return
  // 260821 Red：BottomSpacer 恒在最后一行（timelineRows 472 行），行插入时它被新行顶后一位——
  // 前缀比较前先剔除末位 spacer，否则每次行插入（工具行等）都 invalidate → 60px 整列塌缩。
  // 顶部加载历史 / compaction 截断 / 回滚等真中间变更（prefixDiffAt 落在中部）照旧失效。
  const prev = entry.keys.at(-1) === "bottom-spacer" ? entry.keys.slice(0, -1) : entry.keys
  const next = keys.at(-1) === "bottom-spacer" ? keys.slice(0, -1) : keys
  // 260821 Red：行只追加在末尾（消息 append）时，旧缓存按索引存的尺寸仍有效。
  // 原 sameKeys 严格相等会让一次新行插入丢弃全部缓存 → virtualizer 回落到 60px 估算，
  // 工具行（默认展开、几百 px）插入瞬间整列塌缩再逐行测量恢复 → 内容跳变（屏幕闪一下）+ 吞键。
  // 放宽为前缀匹配：顶部加载历史/compaction 截断/回滚等非末尾变更照旧失效。
  if (next.length >= prev.length && prev.every((key, i) => next[i] === key)) return entry.cache
  timelineCache.delete(id)
}

function writeTimelineCache(id: string, keys: readonly string[], handle: VirtualizerHandle | undefined) {
  if (!handle || keys.length === 0) return
  timelineCache.delete(id)
  timelineCache.set(id, { keys: keys.slice(), cache: handle.cache })
  while (timelineCache.size > timelineCacheLimit) timelineCache.delete(timelineCache.keys().next().value!)
}

function reuseTimelineRows(previous: TimelineRow.TimelineRow[] | undefined, rows: TimelineRow.TimelineRow[]) {
  if (!previous?.length) return rows
  const byKey = new Map(previous.map((row) => [TimelineRow.key(row), row] as const))
  return rows.map((row) => {
    const existing = byKey.get(TimelineRow.key(row))
    if (!existing) return row
    return TimelineRow.equals(existing, row) ? existing : row
  })
}

const taskDescription = (part: PartType, sessionID: string) => {
  if (part.type !== "tool" || part.tool !== "task") return
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionID) return
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
}

const pace = (width: number) => Math.round(Math.max(1200, Math.min(3200, (Math.max(width, 360) * 2000) / 900)))

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

function TimelineThinkingRow(props: {
  reasoningHeading?: string
  showReasoningSummaries: boolean
  startedAt?: number
}) {
  const language = useLanguage()
  // 260811 Red 思考计时：动画行右侧实时秒表，起点为首个 reasoning part 的 time.start
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const elapsed = createMemo(() => {
    const start = props.startedAt
    if (!start) return
    return formatReasoningDuration(Math.max(0, now() - start))
  })

  return (
    <div data-slot="session-turn-thinking" class="flex items-center gap-2">
      <img src="/mona-loading.gif" alt="loading" class="w-6 h-6 shrink-0" style={{ "image-rendering": "pixelated" }} />
      <TextShimmer text={language.t("ui.sessionTurn.status.thinking")} />
      <img src="/hamster.png" alt="" class="w-5 h-5 shrink-0 animate-hamster select-none" aria-hidden="true" />
      {/* 260608 Red 仓鼠改透明底直接平铺：原 mix-blend-mode:screen+深色盒在浅色主题会被洗白 */}
      <Show when={!props.showReasoningSummaries}>
        <TextReveal text={props.reasoningHeading} class="session-turn-thinking-heading" travel={25} duration={700} />
      </Show>
      <Show when={elapsed()}>
        <span
          data-slot="thinking-duration"
          class="ml-auto shrink-0 px-1.5 py-0.5 text-11-regular text-text-weak tabular-nums"
        >
          {elapsed()}
        </span>
      </Show>
    </div>
  )
}

function TimelineDiffSummaryRow(props: { diffs: SummaryDiff[] }) {
  const language = useLanguage()
  const maxFiles = 10
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const overflow = createMemo(() => Math.max(0, props.diffs.length - maxFiles))
  const visible = createMemo(() => (showAll() ? props.diffs : props.diffs.slice(0, maxFiles)))

  return (
    <div
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={showAll() || undefined}
    >
      <div data-slot="session-turn-diffs-header">
        <span data-slot="session-turn-diffs-label">
          {props.diffs.length} {language.t("ui.sessionTurn.diffs.changed")}{" "}
          {language.t(props.diffs.length === 1 ? "ui.common.file.one" : "ui.common.file.other")}
        </span>
        <DiffChanges changes={props.diffs} />
        <Show when={overflow() > 0}>
          <span data-slot="session-turn-diffs-toggle" onClick={() => setState("showAll", !showAll())}>
            {showAll() ? language.t("ui.sessionTurn.diffs.showLess") : language.t("ui.sessionTurn.diffs.showAll")}
          </span>
        </Show>
      </div>
      <div data-component="session-turn-diffs-content">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={expanded()}
          onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={visible()}>
            {(diff) => {
              const opened = createMemo(() => expanded().includes(diff.file))

              return (
                <Accordion.Item value={diff.file}>
                  <StickyAccordionHeader>
                    <Accordion.Trigger>
                      <div data-slot="session-turn-diff-trigger">
                        <span data-slot="session-turn-diff-path">
                          <Show when={diff.file.includes("/")}>
                            <span data-slot="session-turn-diff-directory">{`\u202A${getDirectory(diff.file)}\u202C`}</span>
                          </Show>
                          <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                        </span>
                        <div data-slot="session-turn-diff-meta">
                          <span data-slot="session-turn-diff-changes">
                            <DiffChanges changes={diff} />
                          </span>
                          <span data-slot="session-turn-diff-chevron">
                            <Icon name="chevron-down" size="small" />
                          </span>
                        </div>
                      </div>
                    </Accordion.Trigger>
                  </StickyAccordionHeader>
                  <Accordion.Content>
                    <Show when={opened()}>
                      <TimelineDiffView diff={diff} />
                    </Show>
                  </Accordion.Content>
                </Accordion.Item>
              )
            }}
          </For>
        </Accordion>
        <Show when={!showAll() && overflow() > 0}>
          <div data-slot="session-turn-diffs-more" onClick={() => setState("showAll", true)}>
            {language.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
          </div>
        </Show>
      </div>
    </div>
  )
}

function TimelineDiffView(props: { diff: SummaryDiff }) {
  const fileComponent = useFileComponent()
  const view = normalize(props.diff)

  return (
    <div data-slot="session-turn-diff-view" data-scrollable>
      <Dynamic component={fileComponent} mode="diff" virtualize={false} fileDiff={view.fileDiff} />
    </div>
  )
}

export function MessageTimeline(props: {
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onHistoryScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  shouldAnchorBottom: () => boolean
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  historyShift: boolean
  userMessages: UserMessage[]
  anchor: (id: string) => string
  setRevealMessage?: (fn: (id: string) => void) => void
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()
  const { params, sessionKey } = useSessionKey()
  const platform = usePlatform()

  let virtualizer: VirtualizerHandle | undefined
  const sessionID = createMemo(() => params.id)
  const sessionMessages = createMemo(() => {
    const id = sessionID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const messageByID = createMemo(() => new Map(sessionMessages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    for (const message of sessionMessages()) {
      if (message.role !== "assistant") continue
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        continue
      }
      result.set(message.parentID, [message])
    }
    return result
  })
  const pending = createMemo(() =>
    sessionMessages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    ),
  )
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync.data.session_status[id] ?? idle
  })
  const working = createMemo(() => sessionStatus().type !== "idle")
  const tint = createMemo(() => messageAgentColor(sessionMessages(), sync.data.agent))

  const [timeoutDone, setTimeoutDone] = createSignal(true)

  const workingStatus = createMemo<"hidden" | "showing" | "hiding">((prev) => {
    if (working()) return "showing"
    if (prev === "showing" || !timeoutDone()) return "hiding"
    return "hidden"
  })

  createEffect(() => {
    if (workingStatus() !== "hiding") return

    setTimeoutDone(false)
    makeTimer(() => setTimeoutDone(true), 260, setTimeout)
  })

  const activeMessageID = createMemo(() => {
    const parentID = pending()?.parentID
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus()
    if (status.type !== "idle") {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
    }

    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync.session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const shareUrl = createMemo(() => info()?.share?.url)
  const shareEnabled = createMemo(() => sync.data.config.share !== "disabled")
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return sync.session.get(id)
  })
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
  const getMsgParts = (msgId: string) => sync.data.part[msgId] ?? emptyParts
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => getMsgParts(message.id))
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() => !!(titleValue() || parentID()))

  const messageRowMemos = createMemo(
    mapArray(
      () => props.userMessages,
      (userMessage, indexAccessor) => {
        return createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
          const rows = Timeline.constructMessageRows(
            userMessage,
            getMsgParts,
            assistantMessagesByParent().get(userMessage.id) ?? emptyAssistantMessages,
            indexAccessor(),
            settings.general.showReasoningSummaries(),
            sessionStatus().type,
            activeMessageID() === userMessage.id,
          )

          return reuseTimelineRows(previous, rows)
        })
      },
    ),
  )

  const timelineRows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
    const rows = messageRowMemos().flatMap((memo) => memo())
    if (rows.length === 0) return rows
    return reuseTimelineRows(previous, [...rows, new TimelineRow.BottomSpacer()])
  })
  const timelineRowKeys = createMemo(() => timelineRows().map(TimelineRow.key), [] as string[], { equals: sameKeys })
  const virtualCache = createMemo(() => readTimelineCache(sessionKey(), timelineRowKeys()))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    timelineRows().forEach((row, index) => {
      if (!("userMessageID" in row)) return
      if (result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    timelineRows().forEach((row) => {
      if (row._tag !== "AssistantPart") return
      result.set(row.userMessageID, row.group.key)
    })
    return result
  })
  const keepMounted = createMemo(() => {
    const id = activeMessageID()
    if (!id) return
    const rows = timelineRows()
    const index = rows.findLastIndex((row) => "userMessageID" in row && row.userMessageID === id)
    if (index < 0) return
    return [index]
  })
  const activeAssistantMessages = createMemo(() => {
    const id = activeMessageID() ?? props.userMessages[props.userMessages.length - 1]?.id
    if (!id) return emptyAssistantMessages
    return assistantMessagesByParent().get(id) ?? emptyAssistantMessages
  })
  // 260801 Red 0.7.12：增量版本号替代全量指纹拼接——per-part 签名 Map 比对，只对变化的 part 递增版本号，
  // 避免流式期间每 16ms 全量模板字符串 + join（原 O(parts) 字符串分配）。消费方（500 行 on 依赖）只比较值变化不读内容。
  let assistantContentVersion = 0
  const partSignatures = new Map<string, string>()
  const messageSignatures = new Map<string, string>()
  const activeAssistantContentVersion = createMemo(() => {
    let seenParts: Set<string> | undefined
    const needsCleanup = partSignatures.size > 1000
    if (needsCleanup) seenParts = new Set()
    for (const message of activeAssistantMessages()) {
      const messageSignature = `${message.id}:${message.time.completed ?? ""}:${message.error?.name ?? ""}`
      if (messageSignatures.get(message.id) !== messageSignature) {
        messageSignatures.set(message.id, messageSignature)
        assistantContentVersion++
      }
      for (const part of getMsgParts(message.id)) {
        seenParts?.add(part.id)
        let signature: string
        if (part.type === "text" || part.type === "reasoning") {
          signature = `${part.id}:${part.type}:${part.text.length}`
        } else if (part.type === "tool") {
          const metadata = "metadata" in part.state ? part.state.metadata : undefined
          const output = "output" in part.state && typeof part.state.output === "string" ? part.state.output.length : 0
          const metadataOutput =
            metadata && typeof metadata === "object" && "output" in metadata && typeof metadata.output === "string"
              ? metadata.output.length
              : 0
          signature = `${part.id}:${part.tool}:${part.state.status}:${output}:${metadataOutput}`
        } else {
          signature = `${part.id}:${part.type}`
        }
        if (partSignatures.get(part.id) !== signature) {
          partSignatures.set(part.id, signature)
          assistantContentVersion++
        }
      }
    }
    if (seenParts) {
      for (const id of partSignatures.keys()) {
        if (!seenParts.has(id)) partSignatures.delete(id)
      }
    }
    return assistantContentVersion
  })

  const canAnchorBottom = () => {
    if (!virtualizer) return false
    if (!props.shouldAnchorBottom() && !measuredBottomAnchored) return false
    return timelineRowKeys().length > 0
  }

  // 260822 cc 拆成两条，见 scheduleMeasuredBottomAnchor 上方注释。
  //
  // ① 插行 / 会话状态变化 —— 需要底部锚定循环。timelineRowKeys 用 equals: sameKeys，
  //    只在键列表变化时触发；每个 assistant part 自成一行，所以工具调用会走到这里。
  createEffect(
    on(
      () => [timelineRowKeys(), sessionStatus().type] as const,
      () => {
        if (!canAnchorBottom()) return
        scheduleScrollToEnd()
        scheduleMeasuredBottomAnchor()
      },
      { defer: true },
    ),
  )

  // ② 纯内容增长（文本/推理增量、工具输出变长）—— 只走一次 scrollToEnd。
  //    activeAssistantContentVersion 的签名含 part.text.length，每个 delta 都 bump；
  //    让它去续命锚定循环，等于整段回答期间每帧强制同步布局。
  createEffect(
    on(
      () => activeAssistantContentVersion(),
      () => {
        if (!canAnchorBottom()) return
        scheduleScrollToEnd()
      },
      { defer: true },
    ),
  )

  // 260821 Red：流式期间 delta 每秒 50-100 次，同步 scrollToIndex 每次强制布局+滚动事件链，
  // 主线程每帧被重复布局多次 → 整窗闪烁 + 吞键。节流到每帧最多一次，且 90 帧循环已滚到底时跳过。
  let scrollToEndFrame: number | undefined
  const scheduleScrollToEnd = () => {
    if (scrollToEndFrame !== undefined) return
    scrollToEndFrame = requestAnimationFrame(() => {
      scrollToEndFrame = undefined
      if (!virtualizer || !listRoot) return
      if (isMeasuredBottom(listRoot)) return
      const keys = timelineRowKeys()
      if (keys.length === 0) return
      virtualizer.scrollToIndex(keys.length - 1, { align: "end" })
    })
  }

  createEffect(() => {
    props.setRevealMessage?.((id) => {
      const index = messageRowIndex().get(id)
      if (index === undefined) return
      virtualizer?.scrollToIndex(index, { align: "center" })
    })
  })

  let cacheSessionKey = sessionKey()
  let cacheRowKeys = timelineRowKeys()
  let virtualizerSessionKey = cacheSessionKey
  let virtualizerRowKeys = cacheRowKeys
  let bottomAnchorSessionKey = ""

  const maybeAnchorBottom = () => {
    const key = sessionKey()
    if (bottomAnchorSessionKey === key) return
    if (!virtualizer) return
    const keys = timelineRowKeys()
    if (keys.length === 0) return
    bottomAnchorSessionKey = key
    if (!props.shouldAnchorBottom()) return
    virtualizer.scrollToIndex(keys.length - 1, { align: "end" })
    // 260822 cc scrollToIndex 用的是虚拟**估算**尺寸：缓存未命中时每行按 timelineFallbackItemSize
    //   估，落点可以离真底部很远。再补一轮以实测高度为准的锚定（scrollTop = scrollHeight），
    //   沉降完自动收工。少了这一步就是"切回会话掉在历史中间"。
    scheduleMeasuredBottomAnchor({ force: true })
  }

  createEffect(
    on(
      () => [sessionKey(), timelineRowKeys()] as const,
      (next, prev) => {
        if (prev && prev[0] !== next[0]) writeTimelineCache(prev[0], prev[1], virtualizer)
        cacheSessionKey = next[0]
        cacheRowKeys = next[1]
        if (virtualizer) {
          virtualizerSessionKey = cacheSessionKey
          virtualizerRowKeys = cacheRowKeys
          // 260821 Red 同会话行变化也持续写缓：此前只在切会话时写旧会话，当前会话从未写入 →
          // readTimelineCache 恒 miss → virtualCache 恒 undefined → itemSize 恒 60px fallback →
          // 每次行插入（如工具行）60px 起步 + RO 整列重测 → 布局跳变闪烁。
          // 写入的是 handle.cache 对象引用，virtua 自身会持续往同一对象更新新行实测尺寸。
          writeTimelineCache(next[0], next[1], virtualizer)
          maybeAnchorBottom()
        }
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    writeTimelineCache(virtualizerSessionKey, virtualizerRowKeys, virtualizer)
    props.setRevealMessage?.(() => {})
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
    pendingShare: false,
  })
  let titleRef: HTMLInputElement | undefined

  const [share, setShare] = createStore({
    open: false,
    dismiss: null as "escape" | "outside" | null,
  })
  const [bar, setBar] = createStore({
    ms: pace(640),
  })

  let more: HTMLButtonElement | undefined
  let head: HTMLDivElement | undefined
  let listRoot: HTMLDivElement | undefined
  let listFrame: number | undefined
  let contentFrame: number | undefined
  let bottomAnchorFrame: number | undefined
  let bottomAnchorFrames = 0
  let bottomAnchorSettled = 0
  let bottomAnchorHeight = -1
  let bottomAnchorForce = false
  let measuredBottomAnchored = true
  // 260822 cc IME 组合期暂停底部锚定。见 scheduleMeasuredBottomAnchor 上方注释。
  let imeComposing = false
  const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement>()

  const updateTitleMetrics = () => {
    if (!head || head.clientWidth <= 0) return
    setBar("ms", pace(head.clientWidth))
  }

  createResizeObserver(() => head, updateTitleMetrics)

  const isMeasuredBottom = (root: HTMLDivElement) => root.scrollHeight - root.clientHeight - root.scrollTop <= 4

  const measureTimeline = () => {
    anchorMeasuredBottom()
  }

  function anchorMeasuredBottom() {
    if (!listRoot) return false
    // force：切会话入场时的纠偏。此时 measuredBottomAnchored 往往刚被一次落点偏高的
    // scrollToIndex 经 handleListScroll 置成 false —— 正是需要纠正的状态，不能拿它当门禁，
    // 否则就是"越偏越不修"的死结（表现：切回会话停在历史中间，要自己滚下来）。
    if (!bottomAnchorForce && !measuredBottomAnchored) return false
    // 组合期不写 scrollTop：读 scrollHeight 是强制同步布局，和虚拟列表的重测量挤在一帧里
    // 是很重的主线程任务，会打断 IME 组合、把正在打的字吞掉。循环保持存活，组合结束后
    // 由 compositionend 补一次锚定。
    if (imeComposing) return true
    listRoot.scrollTop = listRoot.scrollHeight
    return true
  }

  // 260822 cc 底部锚定的两处收敛。原实现：任何内容更新都把预算重置成 90 帧，而
  // activeAssistantContentVersion 的签名含 part.text.length —— 每个文本增量都 bump，
  // 于是流式期间预算被反复续命、rAF 永不停止，**整段回答期间每帧都在强制同步布局**。
  //
  // ① 只有插行才重置预算。这个 workaround 本来就是为插行写的（见下方 virtua #301
  //    注释：工具行的初始测量高度会短暂超出）；文本增量只是把已有行撑长，那条路由
  //    scheduleScrollToEnd 走一次 rAF 就够，不需要连续强制布局。
  // ② 不再用固定帧数，改**沉降判据**：滚动高度连续 3 帧不变就收工，90 帧只是硬兜底。
  //    先前那版写死 12 帧（约 0.2s），大会话切回时不够 —— 行是随进入视口才逐个实测的，
  //    预算烧完时还没测到底，循环停在半路，人被留在历史中间。判据收工比固定帧数既省
  //    （静态内容 3 帧就停，不用烧满 90）又稳（慢的场景等得起）。
  // 两个场景对"该锁多久"的要求正好相反，必须分开给预算（260822 第一版混成一个，
  // 流式期间被拉成 90 帧 = 每帧强制同步布局连续 1.5 秒，哥哥实测"闪得比以前还快"）：
  //   插行（流式中调工具）—— 内容每帧都在长，高度永远不会"连续不变"，沉降判据在这里
  //     根本不会触发，只能靠预算收口。短，12 帧足够让新行测完。
  //   切会话入场 —— 内容是静态的，行随进入视口逐个实测，慢的会话 0.2 秒远不够；
  //     但正因为静态，沉降判据一定会触发，通常几帧就收工，90 帧只是兜底。
  const BOTTOM_ANCHOR_FRAMES = 12
  const BOTTOM_ANCHOR_FORCE_FRAMES = 90
  const BOTTOM_ANCHOR_SETTLED_FRAMES = 3

  // 组合期让路：IME 组合中不写 scrollTop，组合结束补一次锚定。
  // 监听挂在 document 上而不是输入框上 —— timeline 拿不到 composer 的 ref，两者是
  // session 页里的同级块；组合事件会冒泡到 document，够用且不需要跨组件接线。
  onMount(() => {
    const onCompositionStart = () => {
      imeComposing = true
    }
    const onCompositionEnd = () => {
      imeComposing = false
      if (canAnchorBottom()) scheduleMeasuredBottomAnchor()
    }
    document.addEventListener("compositionstart", onCompositionStart)
    document.addEventListener("compositionend", onCompositionEnd)
    onCleanup(() => {
      document.removeEventListener("compositionstart", onCompositionStart)
      document.removeEventListener("compositionend", onCompositionEnd)
    })
  })

  function scheduleMeasuredBottomAnchor(options?: { force?: boolean }) {
    // Workaround for virtua issue #301: virtua does not expose a synchronous item-resize hook for
    // "stay at bottom if already at bottom". Tool rows can briefly outgrow the measured virtual
    // height, so keep the scroll container bottom-locked while measurement settles.
    bottomAnchorFrames = options?.force ? BOTTOM_ANCHOR_FORCE_FRAMES : BOTTOM_ANCHOR_FRAMES
    bottomAnchorSettled = 0
    bottomAnchorHeight = -1
    if (options?.force) bottomAnchorForce = true
    if (bottomAnchorFrame !== undefined) return

    const stop = () => {
      bottomAnchorFrames = 0
      bottomAnchorForce = false
    }

    const tick = () => {
      bottomAnchorFrame = undefined
      // 强制纠偏期间用户自己滚了 → 立刻让位，绝不跟人抢滚动条
      if (bottomAnchorForce && props.hasScrollGesture()) return stop()
      if (!anchorMeasuredBottom()) return stop()

      bottomAnchorFrames -= 1
      if (bottomAnchorFrames <= 0) return stop()

      // 组合期 anchorMeasuredBottom 不写 scrollTop，高度不变不能算作沉降，否则会提前收工
      if (!imeComposing) {
        const height = listRoot?.scrollHeight ?? -1
        if (height === bottomAnchorHeight) bottomAnchorSettled += 1
        else {
          bottomAnchorSettled = 0
          bottomAnchorHeight = height
        }
        if (bottomAnchorSettled >= BOTTOM_ANCHOR_SETTLED_FRAMES) return stop()
      }

      bottomAnchorFrame = requestAnimationFrame(tick)
    }

    bottomAnchorFrame = requestAnimationFrame(tick)
  }

  const bindContentRoot = (root: HTMLDivElement) => {
    const child = root.firstElementChild
    props.setContentRef(child instanceof HTMLDivElement ? child : root)
  }

  const scheduleContentRoot = (root: HTMLDivElement) => {
    if (contentFrame !== undefined) cancelAnimationFrame(contentFrame)
    contentFrame = requestAnimationFrame(() => {
      contentFrame = undefined
      if (listRoot !== root) return
      bindContentRoot(root)
    })
  }

  const connectListRoot = (root: HTMLDivElement) => {
    if (listRoot !== root) return
    if (!root.isConnected || !root.ownerDocument.defaultView) {
      listFrame = requestAnimationFrame(() => {
        listFrame = undefined
        connectListRoot(root)
      })
      return
    }

    props.setScrollRef(root)
    measuredBottomAnchored = isMeasuredBottom(root)
    setScrollRoot(root)
    scheduleContentRoot(root)
  }

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot) return

    if (listFrame !== undefined) cancelAnimationFrame(listFrame)
    if (contentFrame !== undefined) cancelAnimationFrame(contentFrame)
    listRoot = root
    setScrollRoot(undefined)
    connectListRoot(root)
  }

  const handleListWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    const root = event.currentTarget
    const delta = normalizeWheelDelta({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rootHeight: root.clientHeight,
    })
    if (!delta) return
    markBoundaryGesture({ root, target: event.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
  }

  const handleListTouchStart = (event: TouchEvent) => {
    touchGesture = event.touches[0]?.clientY
  }

  const handleListTouchMove = (event: TouchEvent & { currentTarget: HTMLDivElement }) => {
    const next = event.touches[0]?.clientY
    const prev = touchGesture
    touchGesture = next
    if (next === undefined || prev === undefined) return

    const delta = prev - next
    if (!delta) return

    markBoundaryGesture({
      root: event.currentTarget,
      target: event.target,
      delta,
      onMarkScrollGesture: props.onMarkScrollGesture,
    })
  }

  const handleListTouchEnd = () => {
    touchGesture = undefined
  }

  const handleListPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.target !== event.currentTarget) return
    props.onMarkScrollGesture(event.currentTarget)
  }

  const handleListScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    measuredBottomAnchored = isMeasuredBottom(event.currentTarget)
    props.onScheduleScrollState(event.currentTarget)
    props.onHistoryScroll()
    if (!props.hasScrollGesture()) return
    props.onUserScroll()
    props.onAutoScrollHandleScroll()
    props.onMarkScrollGesture(event.currentTarget)
  }

  onCleanup(() => {
    if (listFrame !== undefined) cancelAnimationFrame(listFrame)
    if (contentFrame !== undefined) cancelAnimationFrame(contentFrame)
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    if (scrollToEndFrame !== undefined) cancelAnimationFrame(scrollToEndFrame)
    setScrollRoot(undefined)
    props.setScrollRef(undefined)
  })

  const viewShare = () => {
    const url = shareUrl()
    if (!url) return
    platform.openLink(url)
  }

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const shareMutation = useMutation(() => ({
    mutationFn: (id: string) => serverSDK.client.session.share({ sessionID: id, directory: sdk.directory }),
    onError: (err) => {
      console.error("Failed to share session", err)
    },
  }))

  const unshareMutation = useMutation(() => ({
    mutationFn: (id: string) => serverSDK.client.session.unshare({ sessionID: id, directory: sdk.directory }),
    onError: (err) => {
      console.error("Failed to unshare session", err)
    },
  }))

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk.client.session.update({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync.set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  const shareSession = () => {
    const id = sessionID()
    if (!id || shareMutation.isPending) return
    if (!shareEnabled()) return
    shareMutation.mutate(id)
  }

  const unshareSession = () => {
    const id = sessionID()
    if (!id || unshareMutation.isPending) return
    if (!shareEnabled()) return
    unshareMutation.mutate(id)
  }

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
          pendingShare: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (sync.data.message[id] !== undefined) return
        void sync.session.sync(id)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    if (parentID) {
      navigate(`/${params.dir}/session/${parentID}`)
      return
    }
    if (nextSessionID) {
      navigate(`/${params.dir}/session/${nextSessionID}`)
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const archiveSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return

    const sessions = sync.data.session ?? []
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    await sdk.client.session
      .update({ sessionID, time: { archived: Date.now() } })
      .then(() => {
        sync.set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session.splice(index, 1)
          }),
        )
        navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const deleteSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${params.dir}/session/${id}`)
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(sync.session.get(props.sessionID)?.title) ?? language.t("command.session.new"),
    )
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: name() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const workingTurn = (userMessageID: string) => sessionStatus().type !== "idle" && activeMessageID() === userMessageID

  const turnDurationMs = (userMessageID: string) => {
    const message = messageByID().get(userMessageID)
    if (!message || message.role !== "user") return
    const end = (assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages).reduce<number | undefined>(
      (max, item) => {
        const completed = item.time.completed
        if (typeof completed !== "number") return max
        if (max === undefined) return completed
        return Math.max(max, completed)
      },
      undefined,
    )
    if (typeof end !== "number") return
    if (end < message.time.created) return
    return end - message.time.created
  }

  const assistantCopyPartID = (userMessageID: string) => {
    if (workingTurn(userMessageID)) return null
    const messages = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = getMsgParts(message.id)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }
  }

  const getMsgPart = (messageID: string, partID: string) => getMsgParts(messageID).find((part) => part.id === partID)

  const renderAssistantPartGroup = (row: Accessor<TimelineRowMap["AssistantPart"]>) => {
    if (row().group.type === "context") {
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "context") return emptyTools
        return group.refs
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((part): part is ToolPart => part?.type === "tool")
      })

      return (
        <ContextToolGroup
          parts={parts()}
          busy={
            workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
        />
      )
    }

    const message = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      return messageByID().get(group.ref.messageID)
    })
    const part = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      return getMsgPart(group.ref.messageID, group.ref.partID)
    })
    const defaultOpen = createMemo(() => {
      const item = part()
      if (!item) return
      return partDefaultOpen(item, settings.general.shellToolPartsExpanded(), settings.general.editToolPartsExpanded())
    })

    return (
      <Show when={message()}>
        {(message) => (
          <Show when={part()}>
            {(part) => (
              <MessagePart
                part={part()}
                message={message()}
                showAssistantCopyPartID={assistantCopyPartID(row().userMessageID)}
                turnDurationMs={turnDurationMs(row().userMessageID)}
                defaultOpen={defaultOpen()}
                deferToolContent={false}
              />
            )}
          </Show>
        )}
      </Show>
    )
  }

  function TimelineRowFrame(input: { row: Accessor<FramedTimelineRow>; children: JSX.Element }) {
    const anchor = () => {
      const row = input.row()
      return row._tag === "CommentStrip" || (row._tag === "UserMessage" && row.anchor)
    }
    const previousUserMessage = () => {
      const row = input.row()
      return (row._tag === "CommentStrip" || row._tag === "UserMessage") && row.previousUserMessage
    }
    const previousAssistantPart = () => {
      const row = input.row()
      return row._tag === "AssistantPart" && row.previousAssistantPart
    }

    return (
      <div
        id={anchor() ? props.anchor(input.row().userMessageID) : undefined}
        data-message-id={input.row().userMessageID}
        data-timeline-row={input.row()._tag}
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-200 2xl:max-w-[1000px]": props.centered,
          "md:mx-auto": props.centered,
          "pt-6": previousUserMessage(),
          "pt-3": previousAssistantPart(),
        }}
      >
        <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
          {input.children}
        </div>
      </div>
    )
  }

  const renderTimelineRow = (row: Accessor<TimelineRow.TimelineRow>) => {
    const r = row()
    if (!r) return null
    switch (r._tag) {
      case "CommentStrip": {
        const commentStripRow = row as Accessor<TimelineRowByTag<"CommentStrip">>
        const comments = createMemo(() =>
          getMsgParts(commentStripRow().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? []),
        )
        return (
          <TimelineRowFrame row={commentStripRow}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-end gap-2">
                  <Index each={comments()}>
                    {(comment) => (
                      <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
                        <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                          <FileIcon node={{ path: comment().path, type: "file" }} class="size-3.5 shrink-0" />
                          <span class="truncate">{getFilename(comment().path)}</span>
                          <Show when={comment().selection}>
                            {(selection) => (
                              <span class="shrink-0 text-text-weak">
                                {selection().startLine === selection().endLine
                                  ? `:${selection().startLine}`
                                  : `:${selection().startLine}-${selection().endLine}`}
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                          {comment().comment}
                        </div>
                      </div>
                    )}
                  </Index>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "UserMessage": {
        const userMessageRow = row as Accessor<TimelineRowByTag<"UserMessage">>
        const message = createMemo(() => {
          const m = messageByID().get(userMessageRow().userMessageID)
          if (m?.role === "user") return m
        })
        return (
          <TimelineRowFrame row={userMessageRow}>
            <Show when={message()}>
              {(message) => (
                <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
                  <div data-slot="session-turn-message-content" aria-live="off">
                    <Message
                      message={message()}
                      parts={getMsgParts(userMessageRow().userMessageID)}
                      actions={props.actions}
                      userProfile={{
                        avatar: settings.userProfile.avatar(),
                        displayName: settings.userProfile.displayName(),
                      }}
                    />
                  </div>
                </div>
              )}
            </Show>
          </TimelineRowFrame>
        )
      }
      case "TurnDivider": {
        const turnDividerRow = row as Accessor<TimelineRowByTag<"TurnDivider">>
        return (
          <TimelineRowFrame row={turnDividerRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-compaction">
                <MessageDivider
                  label={language.t(
                    turnDividerRow().label === "compaction"
                      ? "ui.messagePart.compaction"
                      : turnDividerRow().label === "truncated"
                        ? "ui.message.truncated"
                        : "ui.message.interrupted",
                  )}
                />
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "AssistantPart": {
        const assistantPartRow = row as Accessor<TimelineRowByTag<"AssistantPart">>
        return (
          <TimelineRowFrame row={assistantPartRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-assistant-row">
                <div data-slot="session-turn-assistant-avatar">
                  <Avatar
                    fallback="R"
                    src={settings.assistantProfile.avatar() || undefined}
                    size="medium"
                    background="var(--syntax-keyword)"
                    foreground="var(--text-on-accent)"
                  />
                </div>
                <div
                  data-slot="session-turn-assistant-content"
                  aria-hidden={workingTurn(assistantPartRow().userMessageID)}
                >
                  {renderAssistantPartGroup(assistantPartRow)}
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Thinking": {
        const thinkingRow = row as Accessor<TimelineRowByTag<"Thinking">>
        return (
          <TimelineRowFrame row={thinkingRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineThinkingRow
                reasoningHeading={thinkingRow().reasoningHeading}
                showReasoningSummaries={settings.general.showReasoningSummaries()}
                startedAt={thinkingRow().startedAt}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "AssistantPending": {
        const pendingRow = row as Accessor<TimelineRowByTag<"AssistantPending">>
        return (
          <TimelineRowFrame row={pendingRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-assistant-row">
                <div data-slot="session-turn-assistant-avatar">
                  <Avatar
                    fallback="R"
                    src={settings.assistantProfile.avatar() || undefined}
                    size="medium"
                    background="var(--syntax-keyword)"
                    foreground="var(--text-on-accent)"
                  />
                </div>
                <div data-slot="session-turn-assistant-content">
                  {/* 260816 Yuqi 兜底占位：assistant 骨架已到但可渲染 parts 未到，显示生成中而非消失 */}
                  <div class="px-2 py-2 text-12-regular text-text-weak">
                    {language.t("common.loading")}
                    {language.t("common.loading.ellipsis")}
                  </div>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Retry": {
        const retryRow = row as Accessor<TimelineRowByTag<"Retry">>
        return (
          <TimelineRowFrame row={retryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <SessionRetry status={sessionStatus()} show={activeMessageID() === retryRow().userMessageID} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "DiffSummary": {
        const diffSummaryRow = row as Accessor<TimelineRowByTag<"DiffSummary">>
        return (
          <TimelineRowFrame row={diffSummaryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineDiffSummaryRow diffs={diffSummaryRow().diffs} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Error": {
        const errorRow = row as Accessor<TimelineRowByTag<"Error">>
        return (
          <TimelineRowFrame row={errorRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <Card variant="error" class="error-card">
                {errorRow().text}
              </Card>
            </div>
          </TimelineRowFrame>
        )
      }
      case "BottomSpacer":
        return <div data-timeline-row="bottom-spacer" aria-hidden="true" class="h-16" />
    }
  }

  function TimelineRowView(props: { row: TimelineRow.TimelineRow }) {
    return renderTimelineRow(() => props.row)
  }

  return (
    <div class="relative w-full h-full min-w-0">
      <div
        class="absolute left-1/2 -translate-x-1/2 bottom-6 z-[60] pointer-events-none transition-all duration-200 ease-out"
        classList={{
          "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump,
          "opacity-0 translate-y-2 scale-95 pointer-events-none": !props.scroll.overflow || !props.scroll.jump,
        }}
      >
        <button
          class="pointer-events-auto flex items-center justify-center w-10 h-8 bg-transparent border-none cursor-pointer p-0 group"
          onClick={props.onResumeScroll}
        >
          <div
            class="flex items-center justify-center w-8 h-6 rounded-[6px] border border-border-weaker-base bg-[color-mix(in_srgb,var(--surface-raised-stronger-non-alpha)_80%,transparent)] backdrop-blur-[0.75px] transition-colors group-hover:border-[var(--border-weak-base)] group-hover:[--icon-base:var(--icon-hover)]"
            style={{
              "box-shadow":
                "0 51px 60px 0 rgba(0,0,0,0.10), 0 15px 18px 0 rgba(0,0,0,0.12), 0 6.386px 7.513px 0 rgba(0,0,0,0.12), 0 2.31px 2.717px 0 rgba(0,0,0,0.20)",
            }}
          >
            <Icon name="arrow-down-to-line" size="small" />
          </div>
        </button>
      </div>
      <ScrollView
        viewportRef={bindListRoot}
        onWheel={handleListWheel}
        onTouchStart={handleListTouchStart}
        onTouchMove={handleListTouchMove}
        onTouchEnd={handleListTouchEnd}
        onTouchCancel={handleListTouchEnd}
        onPointerDown={handleListPointerDown}
        onScroll={handleListScroll}
        onClick={props.onAutoScrollInteraction}
        class="relative min-w-0 w-full h-full"
        style={{
          "--sticky-accordion-top": showHeader() ? "48px" : "0px",
        }}
      >
        <Show when={showHeader()}>
          <div
            ref={(el) => {
              head = el
              updateTitleMetrics()
            }}
            data-session-title
            classList={{
              "sticky top-0 z-30": true,
              "w-full": true,
              "pb-4": true,
              "pl-2 pr-3 md:pl-4 md:pr-3": true,
              "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
            }}
            style={{
              "background-color": "rgba(18, 18, 18, 0.15)",
              "backdrop-filter": "blur(4px)",
              "-webkit-backdrop-filter": "blur(4px)",
            }}
          >
            <Show when={workingStatus() !== "hidden" && settings.general.showSessionProgressBar()}>
              <div data-component="session-progress" data-state={workingStatus()} aria-hidden="true">
                <div
                  data-component="session-progress-bar"
                  style={{
                    background: tint() ?? "var(--icon-interactive-base)",
                    animation: `session-progress-whip ${bar.ms}ms infinite`,
                  }}
                />
              </div>
            </Show>
            <div class="h-12 w-full flex items-center justify-between gap-2">
              <div class="flex items-center gap-1 min-w-0 flex-1 pr-3">
                <div class="flex items-center min-w-0 grow-1">
                  <Show when={parentID()}>
                    <button
                      type="button"
                      data-slot="session-title-parent"
                      class="min-w-0 max-w-[40%] truncate text-14-medium text-text-weak transition-colors hover:text-text-base"
                      onClick={navigateParent}
                    >
                      {parentTitle()}
                    </button>
                    <span
                      data-slot="session-title-separator"
                      class="px-2 text-14-medium text-text-weak"
                      aria-hidden="true"
                    >
                      /
                    </span>
                  </Show>
                  <div
                    class="shrink-0 flex items-center justify-center overflow-hidden transition-[width,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                    style={{
                      width: working() ? "16px" : "0px",
                      "margin-right": working() ? "8px" : "0px",
                    }}
                    aria-hidden="true"
                  >
                    <Show when={workingStatus() !== "hidden"}>
                      <div
                        class="transition-opacity duration-200 ease-out"
                        classList={{ "opacity-0": workingStatus() === "hiding" }}
                      >
                        <Spinner class="size-4" style={{ color: tint() ?? "var(--icon-interactive-base)" }} />
                      </div>
                    </Show>
                  </div>
                  <Show when={childTitle() || title.editing}>
                    <Show
                      when={title.editing}
                      fallback={
                        <h1
                          data-slot="session-title-child"
                          class="text-14-medium text-text-strong truncate grow-1 min-w-0"
                          onDblClick={openTitleEditor}
                        >
                          {childTitle()}
                        </h1>
                      }
                    >
                      <InlineInput
                        ref={(el) => {
                          titleRef = el
                        }}
                        data-slot="session-title-child"
                        value={title.draft}
                        disabled={titleMutation.isPending}
                        class="text-14-medium text-text-strong grow-1 min-w-0 rounded-[6px] pl-1 -ml-1"
                        style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
                        onInput={(event) => setTitle("draft", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void saveTitleEditor()
                            return
                          }
                          if (event.key === "Escape") {
                            event.preventDefault()
                            closeTitleEditor()
                          }
                        }}
                        onBlur={closeTitleEditor}
                      />
                    </Show>
                  </Show>
                </div>
              </div>
              <Show when={sessionID()} keyed>
                {(id) => (
                  <div class="shrink-0 flex items-center gap-3">
                    <Show when={!parentID()}>
                      <DropdownMenu
                        gutter={4}
                        placement="bottom-end"
                        open={title.menuOpen}
                        onOpenChange={(open) => {
                          setTitle("menuOpen", open)
                          if (open) return
                        }}
                      >
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                          classList={{
                            "bg-surface-base-active": share.open || title.pendingShare,
                          }}
                          aria-label={language.t("common.moreOptions")}
                          aria-expanded={title.menuOpen || share.open || title.pendingShare}
                          ref={(el: HTMLButtonElement) => {
                            more = el
                          }}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            style={{ "min-width": "104px" }}
                            onCloseAutoFocus={(event) => {
                              if (title.pendingRename) {
                                event.preventDefault()
                                setTitle("pendingRename", false)
                                openTitleEditor()
                                return
                              }
                              if (title.pendingShare) {
                                event.preventDefault()
                                requestAnimationFrame(() => {
                                  setShare({ open: true, dismiss: null })
                                  setTitle("pendingShare", false)
                                })
                              }
                            }}
                          >
                            <DropdownMenu.Item
                              onSelect={() => {
                                setTitle("pendingRename", true)
                                setTitle("menuOpen", false)
                              }}
                            >
                              <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <Show when={shareEnabled()}>
                              <DropdownMenu.Item
                                onSelect={() => {
                                  setTitle({ pendingShare: true, menuOpen: false })
                                }}
                              >
                                <DropdownMenu.ItemLabel>
                                  {language.t("session.share.action.share")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <DropdownMenu.Item onSelect={() => void archiveSession(id)}>
                              <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item
                              onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}
                            >
                              <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>

                      <KobaltePopover
                        open={share.open}
                        anchorRef={() => more}
                        placement="bottom-end"
                        gutter={4}
                        modal={false}
                        onOpenChange={(open) => {
                          if (open) setShare("dismiss", null)
                          setShare("open", open)
                        }}
                      >
                        <KobaltePopover.Portal>
                          <KobaltePopover.Content
                            data-component="popover-content"
                            style={{ "min-width": "320px" }}
                            onEscapeKeyDown={(event) => {
                              setShare({ dismiss: "escape", open: false })
                              event.preventDefault()
                              event.stopPropagation()
                            }}
                            onPointerDownOutside={() => {
                              setShare({ dismiss: "outside", open: false })
                            }}
                            onFocusOutside={() => {
                              setShare({ dismiss: "outside", open: false })
                            }}
                            onCloseAutoFocus={(event) => {
                              if (share.dismiss === "outside") event.preventDefault()
                              setShare("dismiss", null)
                            }}
                          >
                            <div class="flex flex-col p-3">
                              <div class="flex flex-col gap-1">
                                <div class="text-13-medium text-text-strong">
                                  {language.t("session.share.popover.title")}
                                </div>
                                <div class="text-12-regular text-text-weak">
                                  {shareUrl()
                                    ? language.t("session.share.popover.description.shared")
                                    : language.t("session.share.popover.description.unshared")}
                                </div>
                              </div>
                              <div class="mt-3 flex flex-col gap-2">
                                <Show
                                  when={shareUrl()}
                                  fallback={
                                    <Button
                                      size="large"
                                      variant="primary"
                                      class="w-full"
                                      onClick={shareSession}
                                      disabled={shareMutation.isPending}
                                    >
                                      {shareMutation.isPending
                                        ? language.t("session.share.action.publishing")
                                        : language.t("session.share.action.publish")}
                                    </Button>
                                  }
                                >
                                  <div class="flex flex-col gap-2">
                                    <TextField
                                      value={shareUrl() ?? ""}
                                      readOnly
                                      copyable
                                      copyKind="link"
                                      tabIndex={-1}
                                      class="w-full"
                                    />
                                    <div class="grid grid-cols-2 gap-2">
                                      <Button
                                        size="large"
                                        variant="secondary"
                                        class="w-full shadow-none border border-border-weak-base"
                                        onClick={unshareSession}
                                        disabled={unshareMutation.isPending}
                                      >
                                        {unshareMutation.isPending
                                          ? language.t("session.share.action.unpublishing")
                                          : language.t("session.share.action.unpublish")}
                                      </Button>
                                      <Button
                                        size="large"
                                        variant="primary"
                                        class="w-full"
                                        onClick={viewShare}
                                        disabled={unshareMutation.isPending}
                                      >
                                        {language.t("session.share.action.view")}
                                      </Button>
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            </div>
                          </KobaltePopover.Content>
                        </KobaltePopover.Portal>
                      </KobaltePopover>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
        <Show when={scrollRoot()}>
          {(root) => (
            <Virtualizer
              data={timelineRows()}
              cache={virtualCache()}
              itemSize={virtualCache() ? undefined : timelineFallbackItemSize}
              scrollRef={root()}
              shift={props.historyShift}
              keepMounted={keepMounted()}
              startMargin={64}
              ref={(handle) => {
                if (!handle) {
                  writeTimelineCache(virtualizerSessionKey, virtualizerRowKeys, virtualizer)
                  virtualizer = undefined
                  return
                }
                virtualizer = handle
                virtualizerSessionKey = cacheSessionKey
                virtualizerRowKeys = cacheRowKeys
                maybeAnchorBottom()
                scheduleContentRoot(root())
              }}
            >
              {(row) => <TimelineRowView row={row} />}
            </Virtualizer>
          )}
        </Show>
      </ScrollView>
    </div>
  )
}
