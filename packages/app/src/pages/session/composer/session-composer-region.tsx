import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useSpring } from "@redcode-ai/ui/motion-spring"
import { PromptInput } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSync } from "@/context/sync"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionKey } from "@/pages/session/session-layout"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import type { FollowupDraft } from "@/components/prompt-input/submit"

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  centered: boolean
  placement?: "dock" | "inline"
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeChange?: (worktree: string) => void
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  followup?: {
    queue: () => boolean
    items: { id: string; text: string }[]
    sending?: string
    edit?: { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] }
    onQueue: (draft: FollowupDraft) => void
    onAbort: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  const navigate = useNavigate()
  const prompt = usePrompt()
  const language = useLanguage()
  const route = useSessionKey()
  const sync = useSync()

  const handoffPrompt = createMemo(() => getSessionHandoff(route.sessionKey())?.prompt)
  const info = createMemo(() => (route.params.id ? sync.session.get(route.params.id) : undefined))
  const parentID = createMemo(() => info()?.parentID)
  const child = createMemo(() => !!parentID())
  // 260808 Red: 输入框不再随权限/提问弹窗卸载。原来是 `!blocked() || child()`，
  // 弹窗一出现整个 <PromptInput> 被卸载，正在编辑的内容随组件销毁——用户打到一半
  // 被冲掉，且必须先处理弹窗才能继续打。GUI 的弹窗是鼠标点按钮，与输入没有按键冲突
  // （TUI 不同，那边选项键含 h/l，所以 TUI 只保内容、仍禁输入），因此这里直接常驻，
  // 弹窗期间照常打字。
  const showComposer = createMemo(() => true)

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(route.sessionKey(), { prompt: previewPrompt() })
  })

  const [store, setStore] = createStore({
    ready: false,
  })
  let timer: number | undefined
  let frame: number | undefined

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  createEffect(() => {
    route.sessionKey()
    const ready = props.ready
    const delay = 140

    clear()
    setStore("ready", false)
    if (!ready) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, delay)
    })
  })

  onCleanup(clear)

  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  // 260823 Red: 输入框 todo dock 已砍（功能由侧边栏计划面板覆盖，见 session-plan-tab），
  // spring/value 仅服务 revert dock 的 -36*value() 滑入动画。
  const open = createMemo(() => store.ready && !!rolled())
  const progress = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))

  const openParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${route.params.dir}/session/${id}`)
  }

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      classList={{
        "w-full flex flex-col justify-center items-center pointer-events-none": true,
        // 260812 Red 去掉 bg-background-stronger：dock 整条底色就是"输入框外多余颜色"的根源——
        // 输入框两侧/底部透出主题底色（Yuqi=紫条、浅色主题=灰条），哥哥指出输入框外不该有任何
        // 底色，应直接透出聊天背景。index.css 毛玻璃 A 的 dock 背景规则已同步删除。
        "shrink-0 pb-3": props.placement !== "inline",
      }}
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "max-w-[720px] px-0": props.placement === "inline",
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
        }}
      >
        <Show when={props.state.questionRequest()} keyed>
          {(request) => (
            <div>
              <SessionQuestionDock request={request} onSubmit={props.onResponseSubmit} />
            </div>
          )}
        </Show>

        <Show when={props.state.permissionRequest()} keyed>
          {(request) => (
            <div>
              <SessionPermissionDock
                request={request}
                responding={props.state.permissionResponding()}
                onDecide={(response) => {
                  props.onResponseSubmit()
                  props.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={showComposer()}>
          <Show
            when={prompt.ready()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <SessionRevertDock
                        items={revert.items}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestore={revert.onRestore}
                      />
                    </div>
                  )}
                </Show>
                <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                  {handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * value()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestore={revert.onRestore}
                  />
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-10": true,
              }}
              style={{
                "margin-top": `${-lift()}px`,
              }}
            >
              <Show when={props.followup?.items.length}>
                <SessionFollowupDock
                  items={props.followup!.items}
                  sending={props.followup!.sending}
                  onSend={props.followup!.onSend}
                  onEdit={props.followup!.onEdit}
                />
              </Show>
              <Show
                when={child()}
                fallback={
                  // 260808 Red: 这里原本还套了一层 <Show when={!blocked()}>，权限/提问弹窗
                  // 一出现就把 PromptInput 卸载、连同正在编辑的内容一起销毁。已去掉——
                  // 弹窗期间输入框常驻，随便打字（GUI 弹窗是点按钮，没有按键冲突）。
                  <PromptInput
                    variant={props.placement === "inline" ? "new-session" : undefined}
                    ref={props.inputRef}
                    newSessionWorktree={props.newSessionWorktree}
                    onNewSessionWorktreeChange={props.onNewSessionWorktreeChange}
                    onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                    edit={props.followup?.edit}
                    onEditLoaded={props.followup?.onEditLoaded}
                    shouldQueue={props.followup?.queue}
                    onQueue={props.followup?.onQueue}
                    onAbort={props.followup?.onAbort}
                    onSubmit={props.onSubmit}
                  />
                }
              >
                <div
                  ref={props.inputRef}
                  class="w-full rounded-[var(--radius-lg)] border border-border-weak-base bg-background-base p-3 text-16-regular text-text-weak"
                >
                  <span>{language.t("session.child.promptDisabled")} </span>
                  <Show when={parentID()}>
                    <button
                      type="button"
                      class="text-text-base transition-colors hover:text-text-strong"
                      onClick={openParent}
                    >
                      {language.t("session.child.backToParent")}
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
