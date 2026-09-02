import { For, Show, createMemo } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useQueryOptions } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import type { SessionOutlineResponse } from "@redcode-ai/sdk/v2/client"

type Entry = SessionOutlineResponse["entries"][number]
const EMPTY: Entry[] = []

/**
 * 取数容器。**只在「轮次」标签真的被激活时才挂载** —— side panel 的
 * `<Show when={activeTab() === "outline"}>` 决定了这一点，于是不开这个标签的会话
 * 一次目录请求都不会发，不给「点开会话」那条已经优化过的热路径再加一次往返。
 */
export function SessionTurnOutline(props: {
  directory: string
  sessionID: string
  activeMessageID?: string
  busy: boolean
  onJump: (messageID: string) => void
}) {
  const options = useQueryOptions()
  const query = useQuery(() => ({
    ...options.sessionOutline(pathKey(props.directory), props.sessionID),
    enabled: !!props.sessionID,
  }))

  // 260901 cc 先判 isLoading 再读 data：pending 时读 .data 会挂起，而这个标签页在
  //   会话页内，挂起会一路冒到 app.tsx ConnectionGate 那个 fallback 是满屏 Splash 的
  //   Suspense。同 home-usage.tsx 那处的说明。
  const entries = () => (query.isLoading ? EMPTY : (query.data ?? EMPTY))

  return (
    <TurnOutline
      entries={entries()}
      activeMessageID={props.activeMessageID}
      loading={query.isLoading}
      busy={props.busy}
      onJump={props.onJump}
    />
  )
}

/**
 * 轮次导航栏：整份会话日志的每一轮一条，点一条跳过去。
 *
 * 260901 cc 采自 DSH 的 `2026-08-30-web-turn-rail-outline-jump`。要点是**数据不来自已加载的
 * 消息窗口**：窗口只是日志的一个分页后缀（首屏 40 条，往前一页页翻），从它推导导航
 * 就只会列出最近几轮 —— 恰恰是不需要导航也看得到的那部分。目录走服务端的
 * `GET /session/:id/outline`（见 session/outline.ts），跳转由调用方的 loadThrough 负责
 * 把目标翻进窗口再滚过去。
 *
 * 这一层只管渲染与点击，不碰翻页与滚动 —— 那两件事分别在 session-history-loader.ts
 * 和 message-timeline.tsx 里，各自有自己的时序坑，别在这里再抄一份。
 */
export function TurnOutline(props: {
  entries: Entry[]
  activeMessageID?: string
  loading: boolean
  busy: boolean
  onJump: (messageID: string) => void
}) {
  const language = useLanguage()
  // 最新一轮在最上面：长会话里想找的通常是刚才那几轮，而不是开头。
  const rows = createMemo(() => props.entries.slice().reverse())

  return (
    <div data-component="turn-outline" class="flex flex-col h-full min-h-0">
      <Show
        when={rows().length > 0}
        fallback={
          <div class="flex-1 flex items-center justify-center px-4 text-center">
            <span class="text-12-regular text-text-weak">
              {props.loading ? language.t("session.outline.loading") : language.t("session.outline.empty")}
            </span>
          </div>
        }
      >
        <div class="flex-1 min-h-0 overflow-auto px-2 pb-2 flex flex-col gap-1" data-frost-edge>
          <For each={rows()}>
            {(entry) => {
              const active = () => entry.messageID === props.activeMessageID
              return (
                <button
                  type="button"
                  data-slot="turn-outline-item"
                  data-active={active() || undefined}
                  aria-current={active() ? "true" : undefined}
                  disabled={props.busy}
                  onClick={() => props.onJump(entry.messageID)}
                  class="group w-full text-left rounded-md px-2.5 py-2 flex flex-col gap-1
                         transition-colors disabled:opacity-60 disabled:cursor-progress
                         hover:bg-surface-raised-base-hover
                         data-[active]:bg-surface-raised-base data-[active]:shadow-[inset_2px_0_0_var(--v2-border-border-focus)]"
                >
                  <div class="flex items-baseline gap-2 min-w-0">
                    <span class="shrink-0 text-11-regular tabular-nums text-text-weak">{entry.turn}</span>
                    <span class="min-w-0 flex-1 truncate text-12-regular text-text-strong">
                      {entry.prompt || language.t("session.outline.noPrompt")}
                      {entry.promptClipped ? "…" : ""}
                    </span>
                  </div>
                  <Show when={entry.response}>
                    <span class="pl-[1.375rem] text-11-regular text-text-weak line-clamp-2">
                      {entry.response}
                      {entry.responseClipped ? "…" : ""}
                    </span>
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
