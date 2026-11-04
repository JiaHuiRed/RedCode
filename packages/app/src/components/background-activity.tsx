// 261104 Red GUI 版后台活动中心：与 TUI 共用 GET /background / POST cancel 契约。
// 第一批只读：列后台任务与 PTY、点任务行跳到对应会话；终止留在第二批。
import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Button } from "@redcode-ai/ui/button"
import { Dialog } from "@redcode-ai/ui/dialog"
import { Icon } from "@redcode-ai/ui/icon"
import { List } from "@redcode-ai/ui/list"
import { Tooltip } from "@redcode-ai/ui/tooltip"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"

type JobStatus = "running" | "completed" | "error" | "cancelled"

type Job = {
  id: string
  type: string
  title?: string
  status: JobStatus
  startedAt: number | "Infinity" | "-Infinity" | "NaN"
  completedAt?: number | "Infinity" | "-Infinity" | "NaN"
}

type Terminal = {
  id: string
  title: string
  cwd: string
  status: "running" | "exited"
  pid: number
}

type Row = {
  id: string
  kind: "job" | "terminal"
  title: string
  status?: string
  detail: string
  running: boolean
  sessionID?: string
}

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
    const [jobs, terminals] = await Promise.all([
      sdk.client.background.list().then((result) => result.data ?? []),
      sdk.client.pty.list().then((result) => result.data ?? []),
    ])
    return { jobs: jobs as Job[], terminals: terminals as Terminal[] }
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
        detail: `${language.t("dialog.background.type.job")} · ${elapsed(Number(job.completedAt ?? now) - Number(job.startedAt))}`,
        running: job.status === "running",
        sessionID: job.id,
      }))
    const terminals = [...current.terminals]
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"))
      .map<Row>((pty) => ({
        id: pty.id,
        kind: "terminal",
        title: pty.title,
        status: pty.status === "running" ? language.t("dialog.background.status.running") : undefined,
        detail: `${language.t("dialog.background.type.terminal")} · PID ${pty.pid} · ${pty.cwd}`,
        running: pty.status === "running",
      }))
    return [...jobs, ...terminals]
  })

  const running = createMemo(() => rows().filter((row) => row.running).length)

  return (
    <Dialog
      title={language.t("dialog.background.title")}
      description={language.t("dialog.background.description", { running: running(), total: rows().length })}
    >
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.background.empty")}
        key={(row) => row.id}
        items={rows}
        filterKeys={["title", "kind", "status"]}
        onSelect={(row) => {
          if (!row || row.kind !== "job" || !params.dir) return
          dialog.close()
          navigate(`/${params.dir}/session/${row.id}`)
        }}
      >
        {(row) => (
          <div class="flex w-full items-center justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  classList={{
                    "bg-v2-state-fg-warning": row.running,
                    "bg-border-weak-base": !row.running,
                  }}
                />
                <span class="truncate">{row.title}</span>
                <span class="shrink-0 text-11-regular text-text-weaker">{row.status}</span>
              </div>
              <span class="truncate text-11-regular text-text-weaker">{row.detail}</span>
            </div>
            <Show when={row.kind === "job"}>
              <Icon name="chevron-right" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}

// 输入框底栏入口：与 TUI 的「后台 N」一致，10 秒一轮轻量轮询。
export function BackgroundActivityButton() {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const [running, setRunning] = createSignal(0)

  onMount(() => {
    const tick = () => {
      void sdk.client.background
        .list()
        .then((result) => setRunning((result.data ?? []).filter((job) => job.status === "running").length))
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
          "text-v2-text-text-faint": running() === 0,
          "text-v2-state-fg-warning": running() > 0,
        }}
        aria-label={language.t("dialog.background.title")}
        onClick={() => dialog.show(() => <DialogBackground />)}
      >
        <Show when={running() > 0}>
          <span class="size-1.5 rounded-full bg-v2-state-fg-warning" />
        </Show>
        {running() > 0
          ? language.t("prompt.background.running", { count: running() })
          : language.t("prompt.background.button")}
      </Button>
    </Tooltip>
  )
}
