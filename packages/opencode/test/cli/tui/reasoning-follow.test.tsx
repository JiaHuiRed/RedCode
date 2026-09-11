/** @jsxImportSource @opentui/solid */
// 260911 Red Think 行跟随（参考 DSH ui-conversation）：hide 模式流式期显示思考流的最新
// 非空行。本组渲染真实宿主（AssistantMessage → PART_MAPPING → ReasoningPart），断言的是
// 消息行文本而非整帧快照 —— 排版稳定性由 conversation-snapshot 那份守，这里只钉行为。
import { afterEach, describe, expect, test } from "bun:test"
import { AssistantMessage } from "@tui/routes/session/index"
import { destroyFrame, renderFrame } from "./lib/transcript"

afterEach(destroyFrame)

const WIDTH = 72

// fake 的 thinkingMode 默认是 "off"（走全量分支）；跟随只发生在 hide（inMinimal）下。
const hideMode = { thinkingMode: () => "hide" }

function assistantWithReasoning(text: string, done = false) {
  return {
    message: {
      id: "msg_assistant",
      role: "assistant",
      sessionID: "ses_snapshot",
      modelID: "deepseek-v4-flash",
      providerID: "deepseek",
      agent: "build",
      mode: "build",
      time: { created: 1_756_000_001_000, completed: done ? 1_756_000_004_000 : undefined },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } },
      cost: 0,
      path: { cwd: "/repo", root: "/repo" },
      system: [],
    } as never,
    parts: [
      {
        id: "prt_reasoning",
        type: "reasoning",
        text,
        time: done ? { start: 1_756_000_001_000, end: 1_756_000_003_000 } : { start: 1_756_000_001_000 },
      },
    ] as never,
  }
}

const render = (text: string, done = false) =>
  renderFrame(() => <AssistantMessage {...assistantWithReasoning(text, done)} last={true} />, {
    width: WIDTH,
    height: 6,
    session: hideMode,
  })

describe("TUI Think 行跟随", () => {
  test("流式期显示最新非空行", async () => {
    const frame = await render("Let me check the config file\nThen look at the routing table")
    expect(frame).toContain("思考中: Then look at the routing table")
  })

  test("有标题时与最新行叠加显示", async () => {
    const frame = await render("**Analyzing the request**\n\nLet me check the config file")
    expect(frame).toContain("思考中: Analyzing the request — Let me check the config file")
  })

  test("只有标题行时不重复显示", async () => {
    const frame = await render("**Analyzing the request**")
    expect(frame).toContain("思考中: Analyzing the request")
    expect(frame).not.toContain("—")
  })

  test("最新行的粗体标记被清理", async () => {
    const frame = await render("intro\n**bold step** done")
    expect(frame).toContain("思考中: bold step done")
  })

  test("超长最新行截断且保持单行（布局不跳）", async () => {
    const frame = await render("intro\n" + "x".repeat(300))
    const lines = frame.split("\n").filter((line) => line.includes("思考中"))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("…")
  })

  test("完成后仍走 已思考 折叠行（回归）", async () => {
    const frame = await render("**Analyzing the request**\n\nsome body", true)
    expect(frame).toContain("已思考")
  })
})
