import { TextAttributes } from "@opentui/core"
import { createMemo, createResource, onCleanup, onMount } from "solid-js"
import { errorMessage } from "@/util/error"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useRoute } from "@tui/context/route"
import { useProjectNavigation } from "@tui/context/project-navigation"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { sameDirectory } from "@tui/validate-session"
import { useBindings } from "../keymap"
import { DialogPtyOutput } from "./dialog-pty-output"
import { DialogSubagentSteer } from "./dialog-subagent-steer"
import {
  JOB_STATUS,
  jobDetail,
  jobOpenTarget,
  ptyDetail,
  PTY_STATUS,
  type BackgroundJob,
  type BackgroundPty,
} from "./background-detail"

type Item = { kind: "job"; id: string } | { kind: "terminal"; id: string }

// 261116 Red A01/A02：后台活动面板从「唯一能做的事是终止」改成任务导航。
// Enter / 点击默认打开真实子会话（任何状态，只要会话仍在）；终端默认看只读输出。
// 终止是独立的次要动作（确认后执行），查看本身不取消任务、不重发请求、不启动模型轮次。
export function DialogBackground() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const route = useRoute()
  const navigation = useProjectNavigation()
  const toast = useToast()

  const [data, { refetch }] = createResource(async () => {
    const [jobs, terminals] = await Promise.all([sdk.client.background.list(), sdk.client.pty.list()])
    // SDK 把服务端错误放在 result.error 里，不抛异常；不检查会把失败显示成「没有后台活动」。
    if (jobs.error) throw jobs.error
    if (terminals.error) throw terminals.error
    return { jobs: (jobs.data ?? []) as BackgroundJob[], terminals: (terminals.data ?? []) as BackgroundPty[] }
  })

  // 面板里看的就是"现在还在跑什么"，两秒一轮刷新，关掉面板立即停。
  onMount(() => {
    const timer = setInterval(() => void refetch(), 2000)
    onCleanup(() => clearInterval(timer))
  })

  const reopen = () => dialog.replace(() => <DialogBackground />)

  const jobsByID = createMemo(() => new Map((data()?.jobs ?? []).map((job) => [job.id, job])))
  const terminalsByID = createMemo(() => new Map((data()?.terminals ?? []).map((pty) => [pty.id, pty])))

  // 就地说明：后台面板被提示对话框替换，关闭后回到原面板，不把用户甩回会话页。
  function notice(title: string, message: string) {
    return new Promise<void>((resolve) => {
      dialog.replace(() => <DialogBackgroundNotice title={title} message={message} />, resolve)
    }).then(reopen)
  }

  async function openSession(sessionID: string) {
    const loaded = await sdk.client.session
      .get({ sessionID }, { throwOnError: true })
      .then((result) => ({ session: result.data }), (error) => ({ error: errorMessage(error) }))
    if (!("session" in loaded) || !loaded.session?.directory) {
      await notice(
        "会话不可用",
        `子会话 ${sessionID} 已不可用（${"error" in loaded ? loaded.error : "找不到该会话"}）。` +
          "后台记录若仍存在，可以继续查看状态或终止运行中的任务。",
      )
      return
    }
    const current = sync.path.directory || sdk.directory
    if (current && !sameDirectory(loaded.session.directory, current)) {
      if (!navigation?.enabled) {
        await notice(
          "跨工作区会话",
          `该会话属于 ${loaded.session.directory}，当前连接不支持切换工作区，无法直接打开。`,
        )
        return
      }
      dialog.clear()
      await navigation.switchTo(loaded.session.directory, loaded.session.id).catch((error) => {
        toast.show({ variant: "error", title: "切换工作区失败", message: errorMessage(error) })
      })
      return
    }
    route.navigate({ type: "session", sessionID: loaded.session.id })
    dialog.clear()
  }

  async function openJob(job: BackgroundJob) {
    const target = jobOpenTarget(job)
    if (target.kind === "missing") {
      await notice(
        "无法打开会话",
        "该后台任务没有登记所属会话。面板只按服务端记录的 sessionID 打开，不用任务 ID 猜测会话；" +
          "仍可在这里查看状态或终止运行中的任务。",
      )
      return
    }
    await openSession(target.sessionID)
  }

  function openTerminal(pty: BackgroundPty) {
    dialog.replace(() => <DialogPtyOutput pty={pty} onBack={reopen} />)
  }

  // A03：补充要求是独立入口，不藏在终止菜单里；目标任务与所属主任务在编辑器里显示。
  function openSteer(item: Item) {
    if (item.kind !== "job") {
      void notice("不可补充要求", "只有后台子任务支持补充要求；终端只提供只读输出查看。")
      return
    }
    const job = jobsByID().get(item.id)
    if (!job) return
    const target = jobOpenTarget(job)
    if (target.kind === "missing") {
      void notice(
        "无法补充要求",
        "该后台任务没有登记所属会话。面板只按服务端记录的 sessionID 投递，不用任务 ID 猜测会话。",
      )
      return
    }
    if (job.status !== "running") {
      void notice(
        "任务已结束",
        `「${job.title ?? job.type}」当前是${JOB_STATUS[job.status]}状态。` +
          "已结束的子任务不会自动续跑，也不能在这里补充要求；可以在原会话查看记录。",
      )
      return
    }
    dialog.replace(() => (
      <DialogSubagentSteer
        sessionID={target.sessionID}
        taskTitle={job.title ?? job.type}
        parentSessionID={job.parentSessionID}
        onDone={reopen}
      />
    ))
  }

  async function cancelJob(job: BackgroundJob) {
    if (job.status !== "running") {
      await notice(
        "任务已结束",
        `「${job.title ?? job.type}」当前是${JOB_STATUS[job.status]}状态，没有可终止的运行。`,
      )
      return
    }
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

  async function killTerminal(pty: BackgroundPty) {
    if (pty.status !== "running") {
      await notice(
        "终端不可终止",
        `「${pty.title}」当前是${PTY_STATUS[pty.status]}状态。` +
          (pty.status === "orphaned"
            ? "上次进程退出时仍在运行，进程实际状态未知；按 PID 终止可能误杀被复用的进程，因此不提供终止。"
            : "进程已经结束，没有可终止的运行。"),
      )
      return
    }
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

  function cancelSelected(item: Item) {
    if (item.kind === "job") {
      const job = jobsByID().get(item.id)
      if (job) void cancelJob(job)
      return
    }
    const pty = terminalsByID().get(item.id)
    if (pty) void killTerminal(pty)
  }

  // 261106 Red UX-02：加载失败/空态走 emptyContent，不再伪装成 disabled 行——
  // 通用选择器会过滤 disabled 项，那样两者都只剩一句「未找到结果」。
  const emptyContent = createMemo(() => {
    if (data.error) return `加载失败：${errorMessage(data.error)}`
    if (!data()) return "加载中…"
    return "没有后台活动"
  })

  const options = createMemo<DialogSelectOption<Item>[]>(() => {
    const current = data()
    if (!current) return []
    const now = Date.now()
    const running = (job: BackgroundJob) => job.status === "running"
    const jobs = [...current.jobs].sort(
      (a, b) => Number(running(b)) - Number(running(a)) || Number(b.startedAt) - Number(a.startedAt),
    )
    const terminals = [...current.terminals].sort(
      (a, b) => Number(b.status === "running") - Number(a.status === "running"),
    )
    return [
      ...jobs.map((job) => ({
        title: `${running(job) ? "●" : "○"} ${job.title ?? job.type}`,
        value: { kind: "job" as const, id: job.id },
        category: "后台任务",
        description: jobDetail(job, now),
        onSelect: () => void openJob(job),
      })),
      ...terminals.map((pty) => ({
        title: `${pty.status === "running" ? "●" : "○"} ${pty.title}`,
        value: { kind: "terminal" as const, id: pty.id },
        category: "终端",
        description: ptyDetail(pty),
        onSelect: () => openTerminal(pty),
      })),
    ]
  })

  return (
    <DialogSelect
      title="后台活动"
      placeholder="搜索任务或终端..."
      options={options()}
      emptyContent={emptyContent()}
      selectedKey={(option) => `${option.value.kind}:${option.value.id}`}
      actions={[
        {
          command: "background.steer",
          title: "补充要求",
          onTrigger: (option) => openSteer(option.value),
        },
        {
          command: "background.cancel",
          title: "终止",
          onTrigger: (option) => cancelSelected(option.value),
        },
      ]}
      footerHints={[
        { title: "刷新", label: "每 2 秒" },
        { title: "查看", label: "Enter" },
      ]}
    />
  )
}

function DialogBackgroundNotice(props: { title: string; message: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "返回后台",
        group: "Dialog",
        cmd: () => dialog.clear(),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {props.message}
      </text>
      <box flexDirection="row" justifyContent="flex-end">
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>返回后台</text>
        </box>
      </box>
    </box>
  )
}
