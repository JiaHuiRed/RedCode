/** @jsxImportSource @opentui/solid */
// 260828 cc 会话记录整帧文本快照。
//
// 与既有的 inline-tool-wrap 快照的区别：那份手写了 UserMessage/ShellOutput 的替身，
// 只有 InlineToolRow 是真组件；这份用的是 routes/session/index.tsx 里**真正在跑**的
// UserMessage / AssistantMessage。改了消息渲染，这里的 diff 会直接告诉你哪一行变了。
//
// 形态取自 deepseek-harness 的 `snapshots/web/`（33 个场景的 ARIA 树快照）。本仓 TUI
// 天然就是文本，不需要可访问性树这一层转换。缓存命中率那类状态数字在
// test/cli/tui/prompt-usage.test.ts 里钉，两边合起来才对应上游一份快照的覆盖面。
import { afterEach, describe, expect, test } from "bun:test"
import { For, type JSX } from "solid-js"
import { AssistantMessage, UserMessage } from "@tui/routes/session/index"
import { destroyFrame, renderFrame } from "./lib/transcript"

afterEach(destroyFrame)

const WIDTH = 72

function userMessage(text: string, id = "msg_user") {
  return {
    message: { id, role: "user", sessionID: "ses_snapshot", time: { created: 1_756_000_000_000 } } as never,
    parts: [{ id: "prt_1", type: "text", text, synthetic: false }] as never,
  }
}

function assistantMessage(input: {
  id?: string
  parts: unknown[]
  error?: unknown
  modelID?: string
  providerID?: string
}) {
  return {
    message: {
      id: input.id ?? "msg_assistant",
      role: "assistant",
      sessionID: "ses_snapshot",
      modelID: input.modelID ?? "deepseek-v4-flash",
      providerID: input.providerID ?? "deepseek",
      // 助手消息头显示 `Mode · model · duration`，mode 缺了会在 Locale.titlecase 当场炸
      mode: "build",
      error: input.error,
      time: { created: 1_756_000_001_000, completed: 1_756_000_004_000 },
      tokens: { input: 1200, output: 340, reasoning: 0, cache: { read: 11_800, write: 0, miss: 1200 } },
      cost: 0.0012,
      path: { cwd: "/repo", root: "/repo" },
      system: [],
    } as never,
    parts: input.parts as never,
  }
}

const textPart = (text: string, id = "prt_text") => ({ id, type: "text", text, synthetic: false })

// 所有场景走同一个容器 —— 消息行是右对齐的，容器宽度直接决定左边框落在第几列。
// 不统一的话，单条消息的快照钉的是 harness 的产物而不是真实布局（第一版就是这样：
// 同样 72 列，裸渲染边框在第 20 列、包在 box 里在第 61 列）。
const Transcript = (props: { children: JSX.Element }) => (
  <box flexDirection="column" width={WIDTH}>
    {props.children}
  </box>
)

describe("TUI 会话记录整帧", () => {
  test("空会话只有一条用户消息", async () => {
    const msg = userMessage("把 sync 的写入路径读一遍，给出该 pin 的不变量。")
    expect(
      await renderFrame(
        () => (
          <Transcript>
            <UserMessage {...msg} onMouseUp={() => {}} index={0} />
          </Transcript>
        ),
        { width: WIDTH, height: 8 },
      ),
    ).toMatchSnapshot()
  })

  test("一轮问答：用户消息 + 助手回复", async () => {
    const user = userMessage("这条路默认是走的吗？")
    const assistant = assistantMessage({
      parts: [textPart("不是。远程 workspace 同步在同一个 flag 后面，默认整条休眠。")],
    })
    expect(
      await renderFrame(
        () => (
          <Transcript>
            <UserMessage {...user} onMouseUp={() => {}} index={0} />
            <AssistantMessage {...assistant} last={true} />
          </Transcript>
        ),
        { width: WIDTH, height: 14 },
      ),
    ).toMatchSnapshot()
  })

  test("助手回复里的长文本按宽度折行", async () => {
    const assistant = assistantMessage({
      parts: [
        textPart(
          "序号的读与写必须由同一个条件门控：run() 无条件读 event_sequence 算 seq，" +
            "而两条 insert 原本都在 experimentalWorkspaces 后面（默认关），" +
            "结果默认配置下每个事件的 seq 恒为 0，还被 GlobalBus 原样广播出去。",
        ),
      ],
    })
    expect(
      await renderFrame(
        () => (
          <Transcript>
            <AssistantMessage {...assistant} last={true} />
          </Transcript>
        ),
        { width: WIDTH, height: 14 },
      ),
    ).toMatchSnapshot()
  })

  test("多轮连续渲染时相邻消息的间隔", async () => {
    const turns = [
      userMessage("第一问", "msg_u1"),
      userMessage("第二问", "msg_u2"),
      userMessage("第三问", "msg_u3"),
    ]
    expect(
      await renderFrame(
        () => (
          <Transcript>
            <For each={turns}>{(turn, i) => <UserMessage {...turn} onMouseUp={() => {}} index={i()} />}</For>
          </Transcript>
        ),
        { width: WIDTH, height: 16 },
      ),
    ).toMatchSnapshot()
  })

  test("助手消息带错误时的呈现", async () => {
    const assistant = assistantMessage({
      parts: [textPart("正在读取配置……")],
      error: { name: "ProviderAuthError", data: { providerID: "deepseek", message: "invalid api key" } },
    })
    expect(
      await renderFrame(
        () => (
          <Transcript>
            <AssistantMessage {...assistant} last={true} />
          </Transcript>
        ),
        { width: WIDTH, height: 14 },
      ),
    ).toMatchSnapshot()
  })
})
