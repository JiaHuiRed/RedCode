import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { AssistantMessage, Part, SessionStatus, SnapshotFileDiff, UserMessage } from "@redcode-ai/sdk/v2"
import { groupParts, PartGroup, renderable } from "@redcode-ai/ui/message-part"
import { Data, Equal } from "effect"

export type SummaryDiff = SnapshotFileDiff & { file: string }

export type TimelineRowMap = {
  CommentStrip: {
    userMessageID: string
    previousUserMessage: boolean
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
    previousUserMessage: boolean
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted" | "truncated"
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
  }
  Thinking: { userMessageID: string; reasoningHeading?: string }
  Retry: { userMessageID: string }
  DiffSummary: { userMessageID: string; diffs: SummaryDiff[] }
  Error: { userMessageID: string; text: string }
  AssistantPending: { userMessageID: string }
  BottomSpacer: {}
}

export namespace TimelineRow {
  export class CommentStrip extends Data.TaggedClass("CommentStrip")<{
    userMessageID: string
    previousUserMessage: boolean
  }> {}
  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: string
    anchor: boolean
    previousUserMessage: boolean
  }> {}
  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: string
    label: "compaction" | "interrupted" | "truncated"
  }> {}
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
  }> {}
  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: string
    reasoningHeading?: string
    // 260811 Red 思考计时：首个 reasoning part 的 time.start，用于动画行实时秒表
    startedAt?: number
  }> {}
  export class DiffSummary extends Data.TaggedClass("DiffSummary")<{
    userMessageID: string
    diffs: SummaryDiff[]
  }> {}
  export class Error extends Data.TaggedClass("Error")<{
    userMessageID: string
    text: string
  }> {}
  export class AssistantPending extends Data.TaggedClass("AssistantPending")<{
    userMessageID: string
  }> {}
  export class Retry extends Data.TaggedClass("Retry")<{
    userMessageID: string
  }> {}
  export class BottomSpacer extends Data.TaggedClass("BottomSpacer")<{}> {}

  export type TimelineRow =
    | CommentStrip
    | UserMessage
    | TurnDivider
    | AssistantPart
    | Thinking
    | DiffSummary
    | Error
    | AssistantPending
    | Retry
    | BottomSpacer

  export const key = (row: TimelineRow) => {
    switch (row._tag) {
      case "CommentStrip":
        return `comment-strip:${row.userMessageID}`
      case "UserMessage":
        return `user-message:${row.userMessageID}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "Thinking":
        return `thinking:${row.userMessageID}`
      case "DiffSummary":
        return `diff-summary:${row.userMessageID}`
      case "Error":
        return `error:${row.userMessageID}`
      case "AssistantPending":
        return `assistant-pending:${row.userMessageID}`
      case "Retry":
        return `retry:${row.userMessageID}`
      case "BottomSpacer":
        return "bottom-spacer"
    }
  }

  export function equals(a: TimelineRow, b: TimelineRow) {
    return Equal.equals(a, b)
  }

  /**
   * 逐行复用旧的行对象；**整个数组都没变时把 previous 原样还回去**。
   *
   * 260901 cc 之前这个函数（原先私有在 message-timeline.tsx）除了 `!previous?.length`
   * 那条早退，永远 `return rows.map(...)` —— 一个新数组。createMemo 默认按 === 比较，
   * 所以哪怕每一行都复用成功（实测流式期间命中率就是 100%），memo 的返回值引用还是变了，
   * 下游整条派生链每 16ms 全量重跑一遍：timelineRows 对**整个已加载会话** flatMap +
   * 建全量 Map + 逐行 equals；timelineRowKeys / messageRowIndex / lastAssistantGroupKey
   * 各自再遍历一次全量行；Virtualizer 的 data prop 每帧换新引用。
   *
   * 实测（V8）：481 行 0.68ms、1651 行 1.82ms、3601 行 3.96ms，每次 flush 都付。按
   * server-sdk.tsx 的 FLUSH_FRAME_MS = 16 算，中等会话吃掉 4%、长会话 11% 的帧预算，
   * 整段回答期间持续，外加每帧约 2N 次模板串分配喂给 GC。
   *
   * 返回 previous 本身（不是拷贝）才有意义 —— 要的就是让 === 成立、让传播就地停住。
   * 外层调用传的是 [...rows, new BottomSpacer()]：BottomSpacer 每次是新对象，但它没有
   * 字段、key 也是常量，会被 byKey 匹配到上一个并判等，不影响短路。
   */
  export function reuse(previous: TimelineRow[] | undefined, rows: TimelineRow[]) {
    if (!previous?.length) return rows
    const byKey = new Map(previous.map((row) => [key(row), row] as const))
    let changed = rows.length !== previous.length
    const result = rows.map((row, index) => {
      const existing = byKey.get(key(row))
      const next = existing && equals(existing, row) ? existing : row
      if (!changed && next !== previous[index]) changed = true
      return next
    })
    return changed ? result : previous
  }
}

export namespace Timeline {
  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const interruptedMessageIndex = assistantMessages.findIndex((m) => m.error?.name === "MessageAbortedError")
    const interrupted = interruptedMessageIndex !== -1
    const error = assistantMessages.find((m) => m.error && m.error.name !== "MessageAbortedError")?.error

    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) => renderable(part, showReasoning))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    const assistantItems =
      interrupted && !compaction
        ? [
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
            { type: "interrupted" as const },
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
          ]
        : groupParts(assistantPartRefs).map((group) => ({ type: "part" as const, group }))

    if (comments.length > 0)
      rows.push(
        new TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
          previousUserMessage,
        }),
      )

    rows.push(
      new TimelineRow.UserMessage({
        userMessageID: userMessage.id,
        anchor: comments.length === 0,
        previousUserMessage: comments.length === 0 && previousUserMessage,
      }),
    )

    if (compaction) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "compaction",
        }),
      )
    }

    // 260820 cc finish === "length" 是模型撞到输出 token 上限被砍断。TUI 07-28 就标出来了
    // （routes/session/index.tsx 的 finish === "length" 分支），GUI 这边从没读过
    // message.finish —— 话说到一半就结束的回复和正常说完的长得一模一样，用户无从判断。
    //
    // 取最后一条而不是 some()：prompt.ts 的 finished 判定把 "length" 当作终止原因
    // （只有 tool-calls / unknown 会继续），所以被截断的那条必然是本轮最后一条 assistant。
    // 分割线因此画在整段助手输出之后，位置就是话被切断的地方。
    const truncated = assistantMessages.at(-1)?.finish === "length"

    let assistantGroupIndex = 0
    assistantItems.forEach((item) => {
      if (item.type === "interrupted") {
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
          }),
        )
        return
      }

      rows.push(
        // 260822 cc 这里原本还带一个 lastAssistantPart 字段，**全仓没有任何地方读它**
        //   （组件判断"是不是本轮最后一组"用的是 message-timeline.tsx:1178 那个响应式
        //   lastAssistantGroupKey memo）。它唯一的实际作用是坏的：末尾一插新行，原来那行的
        //   lastAssistantPart 就 true→false，行对象因此不再 equals、reuseTimelineRows 复用不到，
        //   而 virtua 的 <For each={可见项}> 按**引用** key（lib/solid/index.jsx:1459）——
        //   于是那一行整棵 DOM 被销毁重建，重建后 virtua 视其为未测量项先隐藏一帧再测高，
        //   表现就是"模型一调工具就闪一下"。纯文字增量不动这个字段，所以只有插行时才闪。
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
        }),
      )
      assistantGroupIndex += 1
    })

    if (truncated) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "truncated",
        }),
      )
    }

    // 260816 Yuqi 兜底：assistant 骨架已进 store（message.updated 先到）但可渲染 parts 未到
    //   （流式生成中 / 切换会话期间 status 缺失）时，原逻辑一行都不渲染 → 回复"凭空消失"。
    //   busy 时 Thinking 行已覆盖，这里只兜非 busy 的静默窗口期。
    if (assistantMessages.length > 0 && assistantItems.length === 0 && !error && !(isActive && status === "busy")) {
      rows.push(new TimelineRow.AssistantPending({ userMessageID: userMessage.id }))
    }

    if (isActive && status === "busy" && !error && (showReasoning ? assistantPartRefs.length === 0 : true)) {
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
        .find((value): value is string => !!value)
      // 260811 Red 思考计时：优先取首个 reasoning part 的 time.start（reasoning-start 事件已写）；
      // 行创建时 reasoning part 可能还没建立（busy 在 reasoning-start 之前就置位），回退到行创建时刻，
      // 这样供应商排队等首 token 的等待也算进秒表
      const startedAt =
        assistantMessages
          .flatMap((message) => getMessageParts(message.id))
          .map((part) => (part.type === "reasoning" && part.time ? part.time.start : undefined))
          .find((value): value is number => typeof value === "number") ?? Date.now()

      rows.push(
        new TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: heading,
          startedAt,
        }),
      )
    }

    if (isActive && status === "retry") rows.push(new TimelineRow.Retry({ userMessageID: userMessage.id }))

    const diffs = (userMessage.summary?.diffs ?? [])
      .reduceRight<SummaryDiff[]>((result, diff) => {
        if (!isSummaryDiff(diff)) return result
        if (result.some((item) => item.file === diff.file)) return result
        result.push(diff)
        return result
      }, [])
      .reverse()
    if (diffs.length > 0 && (status === "idle" || !isActive)) {
      rows.push(
        new TimelineRow.DiffSummary({
          userMessageID: userMessage.id,
          diffs,
        }),
      )
    }

    if (error) {
      const data = error.data?.message
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: unwrapErrorMessage(
            typeof data === "string" ? data : data === undefined || data === null ? "" : String(data),
          ),
        }),
      )
    }

    return rows
  }

  function isSummaryDiff(value: SnapshotFileDiff): value is SummaryDiff {
    return typeof value.file === "string"
  }

  function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!record(json)) return message

    const err = record(json.error) ? json.error : undefined
    if (err) {
      const type = typeof err.type === "string" ? err.type : undefined
      const msg = typeof err.message === "string" ? err.message : undefined
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = typeof err.code === "string" ? err.code : undefined
      if (code) return code
    }

    const msg = typeof json.message === "string" ? json.message : undefined
    if (msg) return msg

    const reason = typeof json.error === "string" ? json.error : undefined
    if (reason) return reason

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return
    return {
      path: next.path,
      comment: next.comment,
      selection: next.selection
        ? {
            startLine: next.selection.startLine,
            endLine: next.selection.endLine,
          }
        : undefined,
    }
  }
}
