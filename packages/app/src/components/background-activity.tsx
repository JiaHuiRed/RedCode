// 261104 Red GUI 版后台活动中心：与 TUI 共用 GET /background / POST cancel 契约。
// 点任务行跳到对应会话；运行中的条目带「终止」，确认后任务走 cancelTree、终端走 pty.remove。
// 261115 Red UX-17：结束的任务有了按需结果端点（GET /background/:jobID/result，有界），
// 完成未看的条目带「待查看」标记，点开是结果对话框——看结果、复制、引用到草稿、
// 跳子会话/父任务，不再只有一个完成状态。
import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Button } from "@redcode-ai/ui/button"
import { Dialog } from "@redcode-ai/ui/dialog"
import { Icon } from "@redcode-ai/ui/icon"
import { List } from "@redcode-ai/ui/list"
import { Tooltip } from "@redcode-ai/ui/tooltip"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { showToast } from "@redcode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { errorMessage } from "@/utils/session-helpers"

type JobStatus = "running" | "completed" | "error" | "cancelled"

type Job = {
  id: string
  type: string
  title?: string
  status: JobStatus
  startedAt: number | "Infinity" | "-Infinity" | "NaN"
  completedAt?: number | "Infinity" | "-Infinity" | "NaN"
  error?: string
  sessionID?: string
}

type JobResult = {
  id: string
  found: boolean
  status?: JobStatus
  title?: string
  output?: string
  truncated: boolean
  totalChars: number
  error?: string
  sessionID?: string
  parentSessionID?: string
}

type Terminal = {
  id: string
  title: string
  cwd: string
  status: "running" | "exited" | "orphaned"
  pid: number
}

type Row = {
  id: string
  kind: "job" | "terminal"
  title: string
  status?: string
  detail: string
  running: boolean
  // 261115 Red UX-17：job 已结束（结果可按需取）与「完成但还没看过」
  done?: boolean
  unseen?: boolean
  sessionID?: string
}

// 已看结果记录是进程内的轻量状态：跨对话框实例共享（关掉面板再开不复活「待查看」），
// 重启归零是可接受的——重启后任务本身大多已被回收。
const seenResults = new Set<string>()

function elapsed(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function DialogBackground() {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const params = useParams()
  const navigate = useNavigate()

  const [data, { refetch }] = createResource(async () => {
    const [jobs, terminals] = await Promise.all([sdk.client.background.list(), sdk.client.pty.list()])
    // SDK 把服务端错误放在 result.error 里，不抛异常；不检查会把失败渲染成「没有后台活动」。
    if (jobs.error) throw jobs.error
    if (terminals.error) throw terminals.error
    return { jobs: (jobs.data ?? []) as Job[], terminals: (terminals.data ?? []) as Terminal[] }
  })

  // 面板里看的就是「现在还在跑什么」，两秒一轮；关掉面板立即停。
  onMount(() => {
    const timer = setInterval(() => void refetch(), 2000)
    onCleanup(() => clearInterval(timer))
  })

  const rows = createMemo<Row[]>(() => {
    const current = data()
    if (!current) return []
    const now = Date.now()
    const jobs = [...current.jobs]
      .sort(
        (a, b) =>
          Number(b.status === "running") - Number(a.status === "running") ||
          Number(b.startedAt) - Number(a.startedAt),
      )
      .map<Row>((job) => ({
        id: job.id,
        kind: "job",
        title: job.title ?? job.type,
        status: language.t(`dialog.background.status.${job.status}`),
        detail: `${language.t("dialog.background.type.job")} · ${elapsed(Number(job.completedAt ?? now) - Number(job.startedAt))}${job.error ? ` · ${job.error}` : ""}`,
        running: job.status === "running",
        done: job.status !== "running",
        unseen: job.status !== "running" && !seenResults.has(job.id),
        sessionID: job.sessionID,
      }))
    const terminals = [...current.terminals]
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"))
      .map<Row>((pty) => ({
        id: pty.id,
        kind: "terminal",
        title: pty.title,
        // 261105 Red orphaned：上次进程退出时仍在运行的终端，重启后从快照恢复，只展示不可终止。
        status:
          pty.status === "running"
            ? language.t("dialog.background.status.running")
            : pty.status === "orphaned"
              ? language.t("dialog.background.status.orphaned")
              : undefined,
        detail: `${language.t("dialog.background.type.terminal")} · PID ${pty.pid} · ${pty.cwd}`,
        running: pty.status === "running",
      }))
    return [...jobs, ...terminals]
  })

  const running = createMemo(() => rows().filter((row) => row.running).length)
  const unseen = createMemo(() => rows().filter((row) => row.unseen).length)

  // 261115 Red UX-17：结束的任务点开结果对话框（按需拉取，有界）；运行中的照旧跳会话。
  const openResult = (row: Row) => {
    seenResults.add(row.id)
    dialog.show(() => <JobResultDialog row={row} />)
  }

  const stop = (row: Row) => {
    dialog.show(() => (
      <ConfirmStop
        row={row}
        onDone={async () => {
          try {
            if (row.kind === "job") {
              const result = await sdk.client.background.cancel({ jobID: row.id })
              // SDK 把服务端错误放在 result.error 里，不抛异常；只 catch 会静默失败。
              if (result.error)
                showToast({
                  variant: "error",
                  title: language.t("common.requestFailed"),
                  description: errorMessage(result.error, language.t("error.chain.unknown")),
                })
            } else {
              const result = await sdk.client.pty.remove({ ptyID: row.id })
              if (result.error)
                showToast({
                  variant: "error",
                  title: language.t("common.requestFailed"),
                  description: errorMessage(result.error, language.t("error.chain.unknown")),
                })
              // 261105 Red 终止未确认时服务端返回 false 并保留登记：必须告诉用户，
              // 否则刷新后还能看到这条，用户分不清是没杀掉还是刷新失败。
              else if (result.data === false)
                showToast({
                  variant: "error",
                  title: language.t("dialog.background.stop.notConfirmed"),
                  description: language.t("dialog.background.stop.notConfirmed.description"),
                })
            }
          } catch (error) {
            showToast({
              variant: "error",
              title: language.t("common.requestFailed"),
              description: error instanceof Error ? error.message : String(error),
            })
          }
          void refetch()
        }}
      />
    ))
  }

  return (
    <Dialog
      title={language.t("dialog.background.title")}
      description={language.t("dialog.background.description", { running: running(), total: rows().length })}
    >
      <Show when={data.error}>
        <div class="px-4 py-2 text-12-regular text-v2-state-fg-danger">
          {language.t("common.requestFailed")}: {errorMessage(data.error, language.t("error.chain.unknown"))}
        </div>
      </Show>
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.background.empty")}
        key={(row) => row.id}
        items={rows}
        filterKeys={["title", "kind", "status"]}
        onSelect={(row) => {
          if (!row || row.kind !== "job") return
          if (row.running) {
            if (!row.sessionID || !params.dir) return
            dialog.close()
            navigate(`/${params.dir}/session/${row.sessionID}`)
            return
          }
          openResult(row)
        }}
      >
        {(row) => (
          <div class="flex w-full items-center justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-0.5">
              <div class="flex items-center gap-2">
                {/* 261115 Red UX-17：待查看（蓝点）与运行中（黄点）分开——完成未看的
                    结果是「回来收」的信号，不该和还在跑的混为一谈 */}
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  classList={{
                    "bg-v2-state-fg-warning": row.running,
                    "bg-v2-state-fg-info": !!row.unseen,
                    "bg-border-weak-base": !row.running && !row.unseen,
                  }}
                />
                <span class="truncate">{row.title}</span>
                <Show when={row.unseen}>
                  <span class="shrink-0 rounded bg-surface-raised px-1 text-11-regular text-v2-state-fg-info">
                    {language.t("dialog.background.unseen")}
                  </span>
                </Show>
                <span class="shrink-0 text-11-regular text-text-weaker">{row.status}</span>
              </div>
              <span class="truncate text-11-regular text-text-weaker">{row.detail}</span>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <Show when={row.running}>
                <span onClick={(event) => event.stopPropagation()}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    class="h-6 px-1.5 text-11-medium text-v2-text-text-faint hover:text-v2-state-fg-danger"
                    onClick={() => stop(row)}
                  >
                    {language.t("dialog.background.stop.action")}
                  </Button>
                </span>
              </Show>
              <Show when={row.kind === "job" && row.sessionID && params.dir && row.running}>
                <Icon name="chevron-right" size="small" class="text-v2-icon-icon-muted" />
              </Show>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}

function ConfirmStop(props: { row: Row; onDone: () => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  return (
    <Dialog
      title={language.t("dialog.background.stop.title")}
      description={language.t("dialog.background.stop.description", { title: props.row.title })}
      fit
    >
      <div class="flex flex-col gap-4 pb-3 pl-6 pr-2.5">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            onClick={() => {
              dialog.close()
              void props.onDone()
            }}
          >
            {language.t("dialog.background.stop.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// 261115 Red UX-17 结果对话框：按需取有界结果（末尾 32K 字符 + 截断标记），提供
// 复制、引用到当前草稿、子会话/父任务入口。引用只写进草稿、不自动发送；被截断时
// 明确标注总量与完整来源，不冒充完整输出。
const QUOTE_CHAR_CAP = 2_000

function JobResultDialog(props: { row: Row }) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const params = useParams()
  const prompt = usePrompt()

  const [result] = createResource(
    () => props.row.id,
    async (jobID) => {
      const response = await sdk.client.background.result({ jobID })
      if (response.error) throw response.error
      return response.data as JobResult
    },
  )

  const jump = (sessionID?: string) => {
    if (!sessionID || !params.dir) return
    dialog.close()
    navigate(`/${params.dir}/session/${sessionID}`)
  }

  const copy = () => {
    const output = result()?.output
    if (!output) return
    void navigator.clipboard.writeText(output)
    showToast({ title: language.t("session.share.copy.copied") })
  }

  // 引用到草稿：把结果摘录追加成一条文本部件，原草稿内容与光标语义不动，也不发送。
  // 来源写在引文头部；超过 2K 字符只带末尾并标注，完整输出走复制/会话。
  const quote = () => {
    const data = result()
    if (!data?.output) return
    const header = `\n\n[后台任务「${props.row.title}」]\n`
    const body = data.truncated ? data.output.slice(-QUOTE_CHAR_CAP) : data.output
    const tail =
      data.truncated && data.output.length > QUOTE_CHAR_CAP
        ? `\n…（${language.t("dialog.background.result.quoteTruncated")}）`
        : ""
    const text = `${header}${body}${tail}\n`
    const parts = prompt.current()
    let offset = 0
    for (const part of parts) {
      if ("content" in part) offset += part.content.length
    }
    prompt.set([...parts, { type: "text", content: text, start: offset, end: offset + text.length }])
    showToast({ title: language.t("dialog.background.result.quoted") })
  }

  return (
    <Dialog title={props.row.title} description={props.row.detail} fit>
      <div class="flex min-w-0 flex-col gap-3 pb-3 pl-6 pr-2.5">
        <Show when={result.error}>
          <div class="text-12-regular text-v2-state-fg-danger">
            {language.t("common.requestFailed")}: {errorMessage(result.error, language.t("error.chain.unknown"))}
          </div>
        </Show>
        <Show when={result()}>
          {(data) => (
            <>
              <Show
                when={data().found}
                fallback={
                  <div class="text-12-regular text-text-weak">
                    {language.t("dialog.background.result.recycled")}
                  </div>
                }
              >
                <Show when={data().output}>
                  {(output) => (
                    <>
                      <Show when={data().truncated}>
                        <div class="text-11-regular text-text-weak">
                          {language.t("dialog.background.result.truncated", {
                            shown: output().length,
                            total: data().totalChars,
                          })}
                        </div>
                      </Show>
                      <pre class="max-h-[320px] overflow-auto rounded-md bg-surface-base px-3 py-2 text-12-regular whitespace-pre-wrap break-words select-text">
                        {output()}
                      </pre>
                    </>
                  )}
                </Show>
                <Show when={!data().output && data().error}>
                  <div class="text-12-regular text-v2-state-fg-danger select-text">{data().error}</div>
                </Show>
                <Show when={!data().output && !data().error}>
                  <div class="text-12-regular text-text-weak">{language.t("dialog.background.result.empty")}</div>
                </Show>
              </Show>
              <div class="flex flex-wrap justify-end gap-2">
                <Show when={data().output}>
                  <Button variant="ghost" size="small" onClick={copy}>
                    {language.t("dialog.background.result.copy")}
                  </Button>
                  <Button variant="secondary" size="small" onClick={quote}>
                    {language.t("dialog.background.result.quote")}
                  </Button>
                </Show>
                <Show when={data().parentSessionID && params.dir}>
                  <Button variant="ghost" size="small" onClick={() => jump(data().parentSessionID)}>
                    {language.t("dialog.background.result.parent")}
                  </Button>
                </Show>
                <Show when={data().sessionID && params.dir}>
                  <Button variant="secondary" size="small" onClick={() => jump(data().sessionID)}>
                    {language.t("dialog.background.result.openSession")}
                  </Button>
                </Show>
                <Button variant="ghost" size="small" onClick={() => dialog.close()}>
                  {language.t("common.close")}
                </Button>
              </div>
            </>
          )}
        </Show>
      </div>
    </Dialog>
  )
}

// 输入框底栏入口：与 TUI 的「后台 N」一致，10 秒一轮轻量轮询。
// 261115 Red UX-17：运行中之外还统计「完成未看」——没有在跑的任务但有结果没收时，
// 入口给「待查看 N」，把用户领回来。
export function BackgroundActivityButton() {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [running, setRunning] = createSignal(0)
  const [unseen, setUnseen] = createSignal(0)

  onMount(() => {
    const tick = () => {
      void sdk.client.background
        .list()
        .then((result) => {
          const jobs = result.data ?? []
          setRunning(jobs.filter((job) => job.status === "running").length)
          setUnseen(jobs.filter((job) => job.status !== "running" && !seenResults.has(job.id)).length)
        })
        .catch(() => {
          // 旧服务端没有 /background 路由：按钮仍然可点，只是不显示计数。
        })
    }
    tick()
    const timer = setInterval(tick, 10_000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Tooltip placement="top" value={language.t("dialog.background.title")}>
      <Button
        data-action="prompt-background"
        type="button"
        variant="ghost"
        size="small"
        class="h-6 shrink-0 gap-1.5 rounded-md px-1.5 text-12-medium"
        classList={{
          "text-v2-text-text-faint": running() === 0 && unseen() === 0,
          "text-v2-state-fg-warning": running() > 0,
          "text-v2-state-fg-info": running() === 0 && unseen() > 0,
        }}
        aria-label={language.t("dialog.background.title")}
        onClick={() => dialog.show(() => <DialogBackground />)}
      >
        <Show when={running() > 0}>
          <span class="size-1.5 rounded-full bg-v2-state-fg-warning" />
        </Show>
        <Show when={running() === 0 && unseen() > 0}>
          <span class="size-1.5 rounded-full bg-v2-state-fg-info" />
        </Show>
        {running() > 0
          ? language.t("prompt.background.running", { count: running() })
          : unseen() > 0
            ? language.t("prompt.background.unseen", { count: unseen() })
            : language.t("prompt.background.button")}
      </Button>
    </Tooltip>
  )
}
