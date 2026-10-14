/** @jsxImportSource @opentui/solid */
// 260911 Red 压缩 checkpoint 原位折叠行（参考 DSH ui-conversation）：折叠态带 caret 与
// 实报上下文对比；点击分割线展开摘要；压缩中由 session.time.compacting 呈现。
// 本组渲染真实 UserMessage（含内部折叠交互），摘要消息走 sync.data 注入。
import { afterEach, describe, expect, test } from "bun:test"
import { CompactingIndicator, UserMessage } from "@tui/routes/session/index"
import { createSignal } from "solid-js"
import { destroyFrame, frameText, mountFrame, renderFrame } from "./lib/transcript"

afterEach(destroyFrame)

const WIDTH = 72
const SUMMARY_TEXT = "这是压缩摘要：前半程读了 sync 与 compaction 两条路径。"

const compactionPart = (before: number, after?: number) => ({
  id: "prt_compaction",
  type: "compaction",
  auto: true,
  tokens_before: before,
  ...(after === undefined ? {} : { tokens_after: after }),
})

const summaryMessage = {
  id: "msg_summary",
  role: "assistant",
  sessionID: "ses_snapshot",
  parentID: "msg_user_compaction",
  mode: "compaction",
  agent: "compaction",
  providerID: "test",
  modelID: "test-model",
  time: { created: 1_756_000_001_000, completed: 1_756_000_002_000 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } },
  cost: 0,
  path: { cwd: "/repo", root: "/repo" },
  system: [],
}

const message = {
  id: "msg_user_compaction",
  role: "user",
  sessionID: "ses_snapshot",
  time: { created: 1_756_000_000_000 },
} as never

const mainMessage = (id: string, created: number, context: number) => ({
  id,
  role: "assistant",
  sessionID: "ses_snapshot",
  parentID: "msg_user_compaction",
  mode: "build",
  agent: "build",
  providerID: "test",
  modelID: "test-model",
  time: { created, completed: created + 1 },
  tokens: { context, input: context, output: 1, reasoning: 0, cache: { read: 0, write: 0, miss: context } },
})

// 摘要消息与正文 parts 由 sync.data 注入；session.get 决定是否处于「压缩中」。
const syncWith = (
  session: Record<string, unknown>,
  summary: Record<string, unknown> = summaryMessage,
  messages: Record<string, unknown>[] = [message, summary],
  parts: Record<string, unknown[]> = {},
) => ({
  data: {
    config: { username: "你" },
    message: { ses_snapshot: messages },
    part: {
      msg_summary: [{ id: "prt_summary", type: "text", text: SUMMARY_TEXT, synthetic: false }],
      ...parts,
    },
    session: [],
    provider: [],
    mcp: {},
    lsp: {},
    permission: {},
  },
  session,
})

const notCompacting = { get: () => undefined }

const render = (
  part: unknown,
  session: Record<string, unknown> = notCompacting,
  summary: Record<string, unknown> = summaryMessage,
  messages: Record<string, unknown>[] = [message, summary],
  parts: Record<string, unknown[]> = {},
) =>
  renderFrame(() => <UserMessage message={message} parts={[part] as never} onMouseUp={() => {}} index={0} />, {
    width: WIDTH,
    height: 12,
    sync: syncWith(session, summary, messages, parts),
  })

describe("TUI 压缩 checkpoint 折叠行", () => {
  test("前后值取压缩前最近请求和压后首个主请求的实报，不显示本地估算", async () => {
    const before = mainMessage("msg_before", 1, 368_080)
    const after = mainMessage("msg_after", 3, 183_469)
    const frame = await render(compactionPart(554_889, 444_276), notCompacting, summaryMessage, [
      before,
      message,
      summaryMessage,
      after,
    ])
    expect(frame).toContain("Compaction 368k → 183k")
    expect(frame).not.toContain("554,889")
    expect(frame).not.toContain("444,276")
    expect(frame).toContain("▸")
  })

  test("压后尚无主请求实报时明确显示待实报，而不展示估算值", async () => {
    const before = mainMessage("msg_before", 1, 368_080)
    const frame = await render(compactionPart(554_889, 444_276), notCompacting, summaryMessage, [
      before,
      message,
      summaryMessage,
    ])
    expect(frame).toContain("Compaction 368k → 待实报")
    expect(frame).not.toContain("554,889")
    expect(frame).not.toContain("444,276")
  })

  test("后续压缩先发生时，不把它的结果冒充为本次压缩的压后实报", async () => {
    const before = mainMessage("msg_before", 1, 368_080)
    const next = { id: "msg_next_compaction", role: "user", sessionID: "ses_snapshot", time: { created: 4 } }
    const frame = await render(
      compactionPart(554_889, 444_276),
      notCompacting,
      summaryMessage,
      [before, message, summaryMessage, next],
      { [next.id]: [{ type: "compaction" }] },
    )
    expect(frame).toContain("已被后续压缩取代")
    expect(frame).not.toContain("554,889")
    expect(frame).not.toContain("444,276")
  })

  test("压缩中显示进行中文案", async () => {
    const frame = await render(compactionPart(12000), { get: () => ({ time: { compacting: 1 } }) })
    expect(frame).toContain("Compaction 压缩中…")
  })

  test("已成功的 checkpoint 不被新压缩的 session 标志覆盖", async () => {
    const before = mainMessage("msg_before", 1, 368_080)
    const after = mainMessage("msg_after", 3, 183_469)
    const frame = await render(
      compactionPart(554_889, 444_276),
      { get: () => ({ time: { compacting: 1 } }) },
      summaryMessage,
      [before, message, summaryMessage, after],
    )
    expect(frame).toContain("Compaction 368k → 183k")
    expect(frame).not.toContain("压缩中")
  })

  for (const name of ["UnknownError", "MessageAbortedError"]) {
    test(`无 finish 的 ${name} 持久显示终态与原因`, async () => {
      const frame = await render(
        compactionPart(12000),
        { get: () => ({ time: { compacting: 1 } }) },
        { ...summaryMessage, error: { name, data: { message: "摘要流已中断" } } },
      )
      expect(frame).toContain(name === "MessageAbortedError" ? "Compaction 已取消" : "Compaction 失败")
      expect(frame).toContain("摘要流已中断")
      expect(frame).not.toContain("压缩中")
    })
  }

  test("原因预览按 Unicode code point 截断，不切开代理对", async () => {
    const reason = `${"a".repeat(99)}😀tail`
    const frame = await render(compactionPart(12000), notCompacting, {
      ...summaryMessage,
      error: { name: "UnknownError", data: { message: reason } },
    })
    expect(frame).toContain("😀")
    expect(frame).not.toContain("�")
    expect(frame).toContain("…（展开查看）")
  })

  test("inactive 的无终态摘要明确显示未完成", async () => {
    const frame = await render(compactionPart(12000), notCompacting, {
      ...summaryMessage,
      time: { created: summaryMessage.time.created },
    })
    expect(frame).toContain("Compaction 未完成")
    expect(frame).not.toContain("压缩中")
  })

  test("marker 已创建但 process 尚未开始时保持中性标签", async () => {
    const frame = await render(compactionPart(12000), notCompacting, {})
    expect(frame).toContain("Compaction")
    expect(frame).not.toContain("Compaction 未完成")
  })

  test("新 marker 运行不把旧的未完成 marker 标为进行中", async () => {
    const sync = syncWith(
      { get: () => ({ time: { compacting: 1 } }) },
      {
        ...summaryMessage,
        time: { created: summaryMessage.time.created },
      },
    )
    const frame = await renderFrame(
      () => <UserMessage message={message} parts={[compactionPart(12000)] as never} onMouseUp={() => {}} index={0} />,
      {
        width: WIDTH,
        height: 12,
        sync: {
          ...sync,
          data: {
            ...sync.data,
            message: {
              ses_snapshot: [
                ...sync.data.message.ses_snapshot,
                {
                  id: "msg_new",
                  role: "user",
                  sessionID: "ses_snapshot",
                  time: { created: summaryMessage.time.created + 1 },
                },
              ],
            },
            part: { ...sync.data.part, msg_new: [{ type: "compaction", auto: false }] },
          },
        },
      },
    )
    expect(frame).toContain("Compaction 未完成")
    expect(frame).not.toContain("压缩中")
  })

  test("失败详情展开时草稿明确标为未提交", async () => {
    const app = await mountFrame(
      () => <UserMessage message={message} parts={[compactionPart(12000)] as never} onMouseUp={() => {}} index={0} />,
      {
        width: WIDTH,
        height: 15,
        sync: syncWith(notCompacting, {
          ...summaryMessage,
          error: { name: "UnknownError", data: { message: "未完成的摘要请求" } },
        }),
      },
    )
    const row = frameText(app)
      .split("\n")
      .findIndex((line) => line.includes("Compaction 失败"))
    await app.mockMouse.click(Math.floor(WIDTH / 2), row)
    await app.renderOnce()
    expect(frameText(app)).toContain("未提交的摘要草稿")
    expect(frameText(app)).toContain(SUMMARY_TEXT)
    expect(frameText(app)).not.toContain("压缩中")
  })

  test("常驻指示随当前压缩启动和结束显示或消失", async () => {
    const startedAt = Date.now()
    const [start, setStart] = createSignal<number | undefined>(startedAt)
    const app = await mountFrame(() => <CompactingIndicator sessionID="ses_snapshot" />, {
      width: WIDTH,
      height: 6,
      sync: syncWith(
        { get: () => ({ time: { compacting: start() } }) },
        {
          ...summaryMessage,
          time: { created: startedAt },
        },
      ),
    })
    expect(frameText(app)).toContain("压缩上下文")
    expect(frameText(app)).toContain("摘要处理中")
    expect(frameText(app)).toContain("test/test-model")
    setStart(undefined)
    await app.renderOnce()
    expect(frameText(app)).not.toContain("压缩上下文")
    setStart(Date.now())
    await app.renderOnce()
    expect(frameText(app)).toContain("压缩上下文")
  })

  test("点击分割线展开摘要与主请求实报上下文", async () => {
    const beforeMessage = mainMessage("msg_before", 1, 368_080)
    const afterMessage = mainMessage("msg_after", 3, 183_469)
    const app = await mountFrame(
      () => (
        <UserMessage
          message={message}
          parts={[compactionPart(554_889, 444_276)] as never}
          onMouseUp={() => {}}
          index={0}
        />
      ),
      {
        width: WIDTH,
        height: 12,
        sync: syncWith(notCompacting, summaryMessage, [beforeMessage, message, summaryMessage, afterMessage]),
      },
    )

    const before = frameText(app)
    expect(before).not.toContain(SUMMARY_TEXT)
    expect(before).toContain("▸")

    const row = before.split("\n").findIndex((line) => line.includes("Compaction 368k → 183k"))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(Math.floor(WIDTH / 2), row)
    await app.renderOnce()

    const after = frameText(app)
    expect(after).toContain(SUMMARY_TEXT)
    expect(after).toContain("压前最近主请求 368,080 → 压后首个主请求 183,469 tokens")
    expect(after).toContain("净减少 50%")
    expect(after).not.toContain("554,889")
    expect(after).not.toContain("444,276")
    expect(after).toContain("▾")
  })
})
