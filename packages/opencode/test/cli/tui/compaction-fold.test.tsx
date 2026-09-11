/** @jsxImportSource @opentui/solid */
// 260911 Red 压缩 checkpoint 原位折叠行（参考 DSH ui-conversation）：折叠态带 caret 与
// token 对比；点击分割线展开摘要与 token 估算；压缩中由 session.time.compacting 呈现。
// 本组渲染真实 UserMessage（含内部折叠交互），摘要消息走 sync.data 注入。
import { afterEach, describe, expect, test } from "bun:test"
import { UserMessage } from "@tui/routes/session/index"
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
  time: { created: 1_756_000_001_000, completed: 1_756_000_002_000 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } },
  cost: 0,
  path: { cwd: "/repo", root: "/repo" },
  system: [],
}

// 摘要消息与正文 parts 由 sync.data 注入；session.get 决定是否处于「压缩中」。
const syncWith = (session: Record<string, unknown>) => ({
  data: {
    config: { username: "你" },
    message: { ses_snapshot: [summaryMessage] },
    part: { msg_summary: [{ id: "prt_summary", type: "text", text: SUMMARY_TEXT, synthetic: false }] },
    session: [],
    provider: [],
    mcp: {},
    lsp: {},
    permission: {},
  },
  session,
})

const message = {
  id: "msg_user_compaction",
  role: "user",
  sessionID: "ses_snapshot",
  time: { created: 1_756_000_000_000 },
} as never

const notCompacting = { get: () => undefined }

const render = (part: unknown, session: Record<string, unknown> = notCompacting) =>
  renderFrame(() => <UserMessage message={message} parts={[part] as never} onMouseUp={() => {}} index={0} />, {
    width: WIDTH,
    height: 12,
    sync: syncWith(session),
  })

describe("TUI 压缩 checkpoint 折叠行", () => {
  test("完成后的折叠行显示 token 对比与展开指示", async () => {
    const frame = await render(compactionPart(12000, 3000))
    expect(frame).toContain("Compaction 12k → 3k")
    expect(frame).toContain("▸")
  })

  test("压缩中显示进行中文案", async () => {
    const frame = await render(compactionPart(12000), { get: () => ({ time: { compacting: 1 } }) })
    expect(frame).toContain("Compaction 压缩中…")
  })

  test("点击分割线展开摘要与 token 估算", async () => {
    const app = await mountFrame(
      () => <UserMessage message={message} parts={[compactionPart(12000, 3000)] as never} onMouseUp={() => {}} index={0} />,
      { width: WIDTH, height: 12, sync: syncWith(notCompacting) },
    )

    const before = frameText(app)
    expect(before).not.toContain(SUMMARY_TEXT)
    expect(before).toContain("▸")

    const row = before.split("\n").findIndex((line) => line.includes("Compaction 12k → 3k"))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(Math.floor(WIDTH / 2), row)
    await app.renderOnce()

    const after = frameText(app)
    expect(after).toContain(SUMMARY_TEXT)
    expect(after).toContain((12000).toLocaleString())
    expect(after).toContain("释放 75%")
    expect(after).toContain("▾")
  })
})
