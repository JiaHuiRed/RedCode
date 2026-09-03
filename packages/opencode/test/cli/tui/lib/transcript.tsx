/** @jsxImportSource @opentui/solid */
// 260828 cc 会话记录（transcript）整帧快照的 harness。
//
// 为什么不立真 provider：TUI 的 context 之间链式依赖 —— Theme 要 KV + TuiConfig，
// Local 要 Sync + SDK + Toast，后两个还带副作用。渲染一条消息就得把 7 层立起来，
// 而消息组件实际只读其中三五个字段（见下面的 fake）。`createSimpleContext.use()`
// 本身只是 `useContext(ctx)`，所以拿到原始 context 直接喂假值即可。
//
// 代价说清楚：**这条路不覆盖 provider 自身的逻辑**（主题解析、模型校验等）。它守的是
// "消息渲染成什么样"，那正是改动最频繁、回归最容易溜过去的一层。
import { SyntaxStyle } from "@opentui/core"
import { Locale } from "@/util/locale"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import { context as ThemeContext } from "@tui/context/theme"
import { context as LocalContext } from "@tui/context/local"
import { context as SyncContext } from "@tui/context/sync"
import { TuiConfigProvider } from "@tui/context/tui-config"
import { OpencodeKeymapProvider } from "@tui/keymap"
import { SessionRenderContext } from "@tui/routes/session/index"
import type { ParentProps } from "solid-js"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"

let active: Awaited<ReturnType<typeof testRender>> | undefined

export function destroyFrame() {
  active?.renderer.destroy()
  active = undefined
}

// 只列消息组件真正读到的字段。缺字段会在渲染时立刻炸，不会静默出错 —— 所以这份
// fake 不需要跟真类型逐字对齐，它自己就是"用到了什么"的清单。
const theme = {
  text: "#e6e6e6",
  textMuted: "#8a8a8a",
  accent: "#7aa2f7",
  error: "#f7768e",
  warning: "#e0af68",
  backgroundPanel: "#1a1b26",
  background: "#16161e",
  success: "#9ece6a",
}

// useTheme() 返回的是 { theme, syntax } —— syntax 供 <markdown>/<code> 上色，
// 渲染器会调它的 getStyle()，所以必须是真的 SyntaxStyle（空对象会当场炸）。
// 用空规则表构造：本组测试守的是排版与文案，不是语法高亮的配色。
// 用 fromTheme([]) 而不是 new SyntaxStyle(...) —— 本仓 scrollback.shared.ts 里的既有写法。
const syntax = SyntaxStyle.fromTheme([])

const local = {
  // agent.color 是函数（按 agent 名给色），不是常量 —— 第一版写成字符串，渲染当场就炸了。
  // 这正是这套 fake 的性质：缺字段/形状不对不会静默，会立刻报出来。
  //
  // 260903 cc label 是补的：c454e8c0 把消息头从 `Locale.titlecase(message.mode)` 换成
  // `local.agent.label(message.agent)`，这份 fake 没跟上，三条快照 TypeError 挂了六天。
  // 真实现是 `sync.data.agent 里查 displayName ?? titlecase`，这里只兜后半段 —— 前半段
  // （displayName 覆盖 titlecase）由 test/cli/tui/transcript.test.ts 钉，不重复。
  agent: { color: () => "#7aa2f7", label: (name: string) => Locale.titlecase(name) },
  displayName: { user: "你", agent: "柳智敏" },
}

// 只列消息组件读到的那点数据。
const sync = {
  data: {
    config: { username: "你" },
    message: {},
    session: [],
    provider: [],
    mcp: {},
    lsp: {},
    permission: {},
  },
}

const session = {
  // 渲染宽度由这里给，不是从 renderer 推 —— 折行行为直接受它支配，所以快照必须固定它。
  width: 72,
  sessionID: "ses_snapshot",
  conceal: () => false,
  thinkingMode: () => "off" as never,
  show思考中: () => false,
  showTimestamps: () => false,
  showDetails: () => false,
  showGenericToolOutput: () => false,
  diffWrapMode: () => "word" as const,
  providers: () => new Map(),
}

/**
 * Keymap 与 TuiConfig 用**真** provider —— `useCommandShortcut` 要从 keymap 里查实际
 * 绑定，喂假值等于把"快捷键提示显示成什么"这件事从快照里摘出去，而它就在消息行上。
 * 其余三个（Theme / Local / Session）喂假值，理由见文件头。
 */
export function Providers(props: ParentProps) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <ThemeContext.Provider value={{ theme, syntax: () => syntax } as never}>
          <LocalContext.Provider value={local as never}>
            <SyncContext.Provider value={sync as never}>
              <SessionRenderContext.Provider value={session as never}>{props.children}</SessionRenderContext.Provider>
            </SyncContext.Provider>
          </LocalContext.Provider>
        </ThemeContext.Provider>
      </TuiConfigProvider>
    </OpencodeKeymapProvider>
  )
}

/**
 * 渲染一帧并返回去掉行尾空白的纯文本。
 *
 * 两次 renderOnce 之间给 25ms —— 消息组件里有 createEffect/异步测量，只渲染一次会
 * 拍到未定型的中间态（既有的 inline-tool-wrap 快照用的是同一手法）。
 */
export async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  active = await testRender(() => <Providers>{component()}</Providers>, options)
  await active.renderOnce()
  await Bun.sleep(25)
  await active.renderOnce()

  return active
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}
