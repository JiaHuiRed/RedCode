import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { createMediaQuery } from "@solid-primitives/media"
import { MessageNav } from "@redcode-ai/ui/message-nav"
import { Button } from "@redcode-ai/ui/button"
import { TextField } from "@redcode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { useQueryOptions } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { pathKey } from "@/utils/path-key"
import type { SessionOutlineResponse, SessionQueryResponses } from "@redcode-ai/sdk/v2/client"

type Entry = SessionOutlineResponse["entries"][number]
// SDK codegen 把 Schema.Number 展开成 number | "Infinity" | … 联合，这里沿用生成形状。
type SearchHit = SessionQueryResponses[200]["results"][number]
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
      toolbar={<SessionSearchPanel sessionID={props.sessionID} busy={props.busy} onJump={props.onJump} />}
    />
  )
}

// 261115 Red UX-15 查找本会话：只记得一个报错、路径或承诺时按字面找回原文。
// 服务端 GET /session/:id/query 是有界字面子串扫描（复用 session_query 的预算判据）；
// 这里 Enter 触发（不逐键扫描），命中显示片段 + 角色 + 时间，点击走 onJump 跳到
// 对应消息（loadThrough 负责把窗口外旧消息翻进来）；有 nextCursor 时「继续搜索」
// 续传——空一页不等于全部没有，扫描预算未覆盖的部分要用户显式追。
type SearchState = {
  q: string
  hits: SearchHit[]
  scannedParts: number
  nextCursor?: string
  error?: string
}

function SessionSearchPanel(props: { sessionID: string; busy: boolean; onJump: (messageID: string) => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [input, setInput] = createSignal("")
  const [state, setState] = createSignal<SearchState | undefined>()
  const [running, setRunning] = createSignal(false)

  // 261115 Red UX-15 复审：分页锚定已执行查询的关键词——用户在结果页改了输入框再点
  // 「继续搜索」，仍按首次查询的 q + 旧游标续传，不把新词混进旧结果；新搜索（无游标）
  // 覆写整份 state，旧分页随之作废。running 守卫保证同一时刻只有一个在途请求，
  // 旧请求不会迟到覆盖新结果。
  const runSearch = async (cursor?: string) => {
    const q = cursor ? (state()?.q ?? "") : input().trim()
    if (!q || running()) return
    setRunning(true)
    try {
      const response = await sdk.client.session.query({ sessionID: props.sessionID, q, cursor }, { throwOnError: true })
      const data = response.data
      setState((prev) =>
        cursor && prev
          ? {
              q,
              hits: [...prev.hits, ...(data?.results ?? [])],
              scannedParts: prev.scannedParts + Number(data?.scannedParts ?? 0),
              nextCursor: data?.nextCursor,
            }
          : {
              q,
              hits: data?.results ?? [],
              scannedParts: Number(data?.scannedParts ?? 0),
              nextCursor: data?.nextCursor,
            },
      )
    } catch (error) {
      setState((prev) => ({
        q,
        hits: prev?.hits ?? [],
        scannedParts: prev?.scannedParts ?? 0,
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setRunning(false)
    }
  }

  // 命中片段按同一字面语义在客户端切三段高亮（服务端是大小写敏感子串）。
  const snippet = (hit: SearchHit) => {
    const text = hit.text.replace(/\s+/g, " ").trim()
    const index = text.indexOf(state()?.q ?? "")
    if (index === -1) return { before: text, match: undefined, after: undefined }
    return {
      before: text.slice(0, index),
      match: text.slice(index, index + (state()?.q.length ?? 0)),
      after: text.slice(index + (state()?.q.length ?? 0)),
    }
  }

  return (
    <div class="flex flex-col gap-1 px-2 pt-2">
      <form
        class="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          void runSearch()
        }}
      >
        <TextField
          value={input()}
          onChange={setInput}
          placeholder={language.t("session.search.placeholder")}
          aria-label={language.t("session.search.placeholder")}
          spellcheck={false}
          autocomplete="off"
          class="h-7 flex-1 text-12-regular"
        />
        <Button type="submit" size="small" disabled={running() || props.busy}>
          {running() ? language.t("session.search.searching") : language.t("session.search.action")}
        </Button>
      </form>
      <Show when={state()}>
        {(data) => (
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between px-1">
              <span class="text-11-regular text-text-weaker">
                {language.t("session.search.scanned", { count: data().scannedParts })}
              </span>
              <button
                type="button"
                class="text-11-regular text-text-weak hover:text-text-strong"
                onClick={() => {
                  setInput("")
                  setState(undefined)
                }}
              >
                ← {language.t("session.search.backToOutline")}
              </button>
            </div>
            <Show when={data().error}>
              <div role="alert" class="px-1 text-11-regular text-text-danger-base">
                {data().error}
              </div>
            </Show>
            <div class="max-h-[320px] overflow-y-auto">
              <Show
                when={data().hits.length > 0}
                fallback={
                  <div class="px-1 py-3 text-12-regular text-text-weak">
                    {language.t("session.search.empty")}
                  </div>
                }
              >
                <For each={data().hits}>
                  {(hit) => {
                    const parts = () => snippet(hit)
                    return (
                      <button
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onJump(hit.messageID)}
                        class="group w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-raised-base disabled:opacity-60"
                      >
                        <div class="flex items-center gap-2 text-11-regular text-text-weaker">
                          <span>{hit.role}</span>
                          <span>{new Date(Number(hit.createdAt)).toLocaleString(language.intl())}</span>
                        </div>
                        <div class="mt-0.5 line-clamp-2 break-words text-12-regular text-text-strong">
                          {parts().before}
                          <mark class="bg-transparent text-v2-state-fg-info">{parts().match}</mark>
                          {parts().after}
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
            <Show when={data().nextCursor}>
              <Button
                size="small"
                variant="secondary"
                disabled={running()}
                onClick={() => void runSearch(data().nextCursor)}
              >
                {language.t("session.search.more")}
              </Button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

/**
 * 260916 Red 侧边消息轨道的取数与跳转决策见
 * `docs/notes/implemented/feature/2026-09-16-session-message-rail.md`。
 */
export function SessionMessageRail(props: {
  directory: string
  sessionID: string
  activeMessageID?: string
  busy: boolean
  onJump: (messageID: string) => void
}) {
  const options = useQueryOptions()
  const isDesktop = createMediaQuery("(min-width: 768px)")
  const query = useQuery(() => ({
    ...options.sessionOutline(pathKey(props.directory), props.sessionID),
    enabled: !!props.sessionID && isDesktop(),
  }))

  const entries = () => (query.isLoading ? EMPTY : (query.data ?? EMPTY))

  const language = useLanguage()
  const rows = createMemo(() => entries().map((entry) => ({ id: entry.messageID })))
  const entryByID = createMemo(() => new Map(entries().map((entry) => [entry.messageID, entry] as const)))
  const current = createMemo(() => rows().find((message) => message.id === props.activeMessageID))

  return (
    <Show when={rows().length > 1}>
      <div
        data-component="session-message-rail"
        // 260917 Red 顶部让开会话标题栏那 64px（h-12 + pb-4）：它是 sticky z-30
        // （message-timeline.tsx:1656），压在 z-[3] 的轨道上，把最上面几个 tick 的
        // 点击与悬停整个吃掉 —— 用户点最早的几轮（最需要跳转的那批）会完全没反应。
        // 让位比抬 z-index 稳：抬 z 会把轨道盖到标题左边缘 parent 链接上，抢掉那边的点击。
        class="pointer-events-none absolute bottom-0 left-1 top-16 z-[3] hidden w-6 md:flex"
        classList={{ "opacity-60": props.busy }}
      >
        <MessageNav
          class="pointer-events-auto h-full max-h-full overflow-y-auto py-8 pl-1 no-scrollbar"
          messages={rows()}
          current={current()}
          size="compact"
          aria-label={language.t("session.tab.outline")}
          onMessageSelect={(message) => {
            if (props.busy) return
            props.onJump(message.id)
          }}
          getLabel={(message) => entryByID().get(message.id)?.prompt}
        />
      </div>
    </Show>
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
  // 261115 Red UX-15：大纲标签页顶部的「查找本会话」面板（搜索结果就地展示）。
  toolbar?: JSX.Element
}) {
  const language = useLanguage()
  // 最新一轮在最上面：长会话里想找的通常是刚才那几轮，而不是开头。
  const rows = createMemo(() => props.entries.slice().reverse())

  return (
    <div data-component="turn-outline" class="flex flex-col h-full min-h-0">
      {props.toolbar}
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
                  /* 260907 ZCode 长会话几千轮 = 几千个按钮，content-visibility:auto 让屏外的
                     跳过布局与绘制（DOM 仍在、点击/滚动定位不受影响）；contain-intrinsic-size
                     的 auto 关键字让浏览器记住每条实测高度，滚动条不跳。为这个次要项引入整套
                     virtua 虚拟化不成比例。 */
                  class="group w-full text-left rounded-md px-2.5 py-2 flex flex-col gap-1
                         transition-colors disabled:opacity-60 disabled:cursor-progress
                         hover:bg-surface-raised-base-hover
                         data-[active]:bg-surface-raised-base data-[active]:shadow-[inset_2px_0_0_var(--v2-border-border-focus)]
                         [content-visibility:auto] [contain-intrinsic-size:auto_40px]"
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
