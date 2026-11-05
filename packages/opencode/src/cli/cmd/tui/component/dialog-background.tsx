import { Locale } from "@/util/locale"
import { errorMessage } from "@/util/error"
import { createMemo, createResource, onCleanup, onMount } from "solid-js"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"

// OpenAPI 的数字字段允许 JSON 的非有限值字符串，落盘前统一用 Number() 收口。
type Num = number | "Infinity" | "-Infinity" | "NaN"

type Job = {
  id: string
  type: string
  title?: string
  status: "running" | "completed" | "error" | "cancelled"
  startedAt: Num
  completedAt?: Num
  error?: string
}

type Terminal = {
  id: string
  title: string
  cwd: string
  status: "running" | "exited" | "orphaned"
  pid: number
}

type Item = { kind: "job"; job: Job } | { kind: "terminal"; pty: Terminal } | { kind: "empty" }

const JOB_STATUS: Record<Job["status"], string> = {
  running: "运行中",
  completed: "已完成",
  error: "失败",
  cancelled: "已取消",
}

// 261104 Red 后台活动面板：把引擎登记的后台任务与 PTY 终端放在同一张表里。
// 只读展示 + 终止；不扫描系统进程，界面上不存在"未知归属"的条目。
export function DialogBackground() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const [data, { refetch }] = createResource(async () => {
    const [jobs, terminals] = await Promise.all([sdk.client.background.list(), sdk.client.pty.list()])
    // SDK 把服务端错误放在 result.error 里，不抛异常；不检查会把失败显示成「没有后台活动」。
    if (jobs.error) throw jobs.error
    if (terminals.error) throw terminals.error
    return { jobs: jobs.data ?? [], terminals: terminals.data ?? [] }
  })

  // 面板里看的就是"现在还在跑什么"，两秒一轮刷新，关掉面板立即停。
  onMount(() => {
    const timer = setInterval(() => void refetch(), 2000)
    onCleanup(() => clearInterval(timer))
  })

  const reopen = () => dialog.replace(() => <DialogBackground />)

  async function cancelJob(job: Job) {
    if (job.status !== "running") return
    const ok = await DialogConfirm.show(
      dialog,
      "终止后台任务",
      `「${job.title ?? job.type}」及其子任务会被中断，已产出的内容保留。`,
      "终止",
    )
    if (!ok) return reopen()
    const result = await sdk.client.background.cancel({ jobID: job.id })
    if (result.error) toast.show({ variant: "error", title: "终止失败", message: errorMessage(result.error) })
    reopen()
  }

  async function killTerminal(pty: Terminal) {
    if (pty.status !== "running") return
    const ok = await DialogConfirm.show(
      dialog,
      "结束终端",
      `将强制结束「${pty.title}」(PID ${pty.pid}) 及其子进程。`,
      "结束进程",
    )
    if (!ok) return reopen()
    const result = await sdk.client.pty.remove({ ptyID: pty.id })
    if (result.error) toast.show({ variant: "error", title: "结束失败", message: errorMessage(result.error) })
    reopen()
  }

  function describeJob(job: Job, now: number) {
    const elapsed = Locale.duration(Number(job.completedAt ?? now) - Number(job.startedAt))
    const base = `${job.type} · ${JOB_STATUS[job.status]} · ${elapsed}`
    return job.error ? `${base} · ${job.error}` : base
  }

  const options = createMemo<DialogSelectOption<Item>[]>(() => {
    if (data.error)
      return [
        {
          title: "加载失败",
          description: errorMessage(data.error),
          value: { kind: "empty" as const },
          disabled: true,
        },
      ]
    const current = data()
    if (!current) return []
    const now = Date.now()
    const running = (job: Job) => job.status === "running"
    const jobs = [...current.jobs].sort(
      (a, b) => Number(running(b)) - Number(running(a)) || Number(b.startedAt) - Number(a.startedAt),
    )
    const terminals = [...current.terminals].sort(
      (a, b) => Number(b.status === "running") - Number(a.status === "running"),
    )
    const items: DialogSelectOption<Item>[] = jobs.map((job) => ({
      title: `${running(job) ? "●" : "○"} ${job.title ?? job.type}`,
      value: { kind: "job" as const, job },
      category: "后台任务",
      description: describeJob(job, now),
      disabled: !running(job),
      onSelect: () => void cancelJob(job),
    }))
    for (const pty of terminals) {
      const status = pty.status === "running" ? "运行中" : pty.status === "orphaned" ? "未正常结束" : "已退出"
      items.push({
        title: `${pty.status === "running" ? "●" : "○"} ${pty.title}`,
        value: { kind: "terminal" as const, pty },
        category: "终端",
        description: `PID ${pty.pid} · ${status} · ${pty.cwd}`,
        disabled: pty.status !== "running",
        onSelect: () => void killTerminal(pty),
      })
    }
    if (items.length === 0) {
      return [{ title: "没有后台活动", value: { kind: "empty" as const }, disabled: true }]
    }
    return items
  })

  return (
    <DialogSelect
      title="后台活动"
      placeholder="搜索任务或终端..."
      options={options()}
      footerHints={[{ title: "刷新", label: "每 2 秒" }]}
    />
  )
}
