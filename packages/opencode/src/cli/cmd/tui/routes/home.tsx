import { Prompt, type PromptRef } from "@tui/component/prompt"
import { usePromptMaxWidth } from "@tui/component/prompt/width"
import { createEffect, createSignal, onMount } from "solid-js"
import { logoLarge } from "@/cli/logo"
import { Logo } from "../component/logo"
import { Starfield } from "../component/starfield"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { useEditorContext } from "@tui/context/editor"

let once = false

// 260731 Red 上下留白按 5:8 分而不是 1:1 —— 整块内容的视觉重心抬到屏幕约 43% 处。
// 等分时 logo 正好压在几何中心，观感上偏"沉"。调大 SPACE_BELOW 会让 logo 更靠上。
const SPACE_ABOVE = 5
const SPACE_BELOW = 8

// 空输入时文本区给 2 行而不是默认的 1 行：首页的输入框是画面主体，1 行显得扁。
// 会话页仍用默认 1 行，那里输入框该让位给对话内容。
const HOME_PROMPT_MIN_HEIGHT = 2

const placeholder = {
  normal: ["修复代码中的 TODO", "这个项目的技术栈是什么？", "修复失败的测试"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const promptMaxWidth = usePromptMaxWidth()
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <box position="absolute" top={0} left={0} right={0} bottom={0} zIndex={0}>
        <Starfield />
      </box>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2} zIndex={1}>
        <box flexGrow={SPACE_ABOVE} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            {/* 260731 Red 首页用大号字形（55×7）；run 的进场 splash 仍用原来的 41×5 */}
            <Logo idle shape={logoLarge} />
          </TuiPluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt
              ref={bind}
              right={<TuiPluginRuntime.Slot name="home_prompt_right" />}
              placeholders={placeholder}
              minHeight={HOME_PROMPT_MIN_HEIGHT}
            />
          </TuiPluginRuntime.Slot>
        </box>
        <TuiPluginRuntime.Slot name="home_bottom" />
        <box flexGrow={SPACE_BELOW} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0} zIndex={1}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
