import { createEffect, onCleanup, onMount } from "solid-js"
import { showToast, toaster } from "@redcode-ai/ui/toast"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { getFilename } from "@redcode-ai/core/util/path"
import { pathKey } from "@/utils/path-key"
import { playSoundById } from "@/utils/sound"
import { findLastCompaction } from "@/components/session/session-context-metrics"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { useLanguage } from "@/context/language"
import type { usePermission } from "@/context/permission"
import type { useSettings } from "@/context/settings"
import type { usePlatform } from "@/context/platform"
import type { useServerSync } from "@/context/server-sync"
import type { useNavigate, useParams } from "@solidjs/router"
import { Worktree as WorktreeState } from "@/utils/worktree"

export function createSDKNotificationToasts(deps: {
  globalSDK: ReturnType<typeof useGlobalSDK>
  language: ReturnType<typeof useLanguage>
  permission: ReturnType<typeof usePermission>
  settings: ReturnType<typeof useSettings>
  platform: ReturnType<typeof usePlatform>
  params: ReturnType<typeof useParams>
  currentDir: () => string
  globalSync: ReturnType<typeof useServerSync>
  navigate: ReturnType<typeof useNavigate>
  setBusy: (directory: string, value: boolean) => void
}) {
  const { globalSDK, language, permission, settings, platform, params, currentDir, globalSync, navigate, setBusy } =
    deps

  onMount(() => {
    const toastBySession = new Map<string, number>()
    const alertedAtBySession = new Map<string, number>()
    const loopToastBySession = new Map<string, number>()
    const loopAlertedAtBySession = new Map<string, { at: number; type: string }>()
    const pendingBySession = new Map<string, object>()
    const cooldownMs = 5000
    const loopCooldownMs = 10000

    const dismissSessionAlert = (sessionKey: string) => {
      const toastId = toastBySession.get(sessionKey)
      if (toastId === undefined) return
      toaster.dismiss(toastId)
      toastBySession.delete(sessionKey)
    }

    const dismissLoopAlert = (sessionKey: string) => {
      const toastId = loopToastBySession.get(sessionKey)
      if (toastId === undefined) return
      toaster.dismiss(toastId)
      loopToastBySession.delete(sessionKey)
    }

    // 261113 Red sessionID 是 `ses_` + 时间降序 + 随机尾段，同批子代理前缀相同；
    // 标题缺失时截前 12 字符无法区分，直接给完整 ID。目录同理给完整路径——
    // worktree 并行的两个子代理可能同名（…/alpha/RedCode、…/beta/RedCode）。
    const sessionLabel = (directory: string, sessionID: string) => {
      const [store] = globalSync.child(directory, { bootstrap: false })
      const session = store.session.find((s: any) => s.id === sessionID)
      const title = session?.title?.trim()
      return title ? `${title} (${sessionID})` : sessionID
    }

    const directoryLabel = (directory: string) => directory.replace(/[/\\]+$/, "") || directory

    const showLoopAlert = (
      sessionKey: string,
      input: { directory: string; sessionID: string; title: string; description: string },
    ) => {
      const href = `/${base64Encode(input.directory)}/session/${input.sessionID}`
      dismissLoopAlert(sessionKey)
      const toastId = showToast({
        persistent: true,
        icon: "shield" as any,
        title: input.title,
        description: input.description,
        actions: [
          {
            label: language.t("notification.action.goToSession"),
            onClick: () => navigate(href),
          },
          {
            label: language.t("common.dismiss"),
            onClick: "dismiss",
          },
        ],
      })
      loopToastBySession.set(sessionKey, toastId)
    }

    const unsub = globalSDK.event.listen(async (e) => {
      if (e.details?.type === "worktree.ready") {
        setBusy(e.name, false)
        WorktreeState.ready(e.name)
        return
      }

      if (e.details?.type === "worktree.failed") {
        setBusy(e.name, false)
        WorktreeState.failed(e.name, e.details.properties?.message ?? language.t("common.requestFailed"))
        return
      }

      if (
        e.details?.type === "question.replied" ||
        e.details?.type === "question.rejected" ||
        e.details?.type === "permission.replied"
      ) {
        const props = e.details.properties as { sessionID: string }
        const sessionKey = `${pathKey(e.name)}:${props.sessionID}`
        pendingBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
        dismissSessionAlert(sessionKey)
        return
      }

      // 261113 Red ngram 循环停止会紧接着发 session.error（TextLoopStoppedError），与
      // loop_detected 是同一次停止。这里只认这个真实错误类型：已有带来源与跳转的停止
      // 提醒时保留它、不撤也不重弹；错误先到（循环事件丢失/重连）时补一张可定位的提醒。
      // 已有 nudge/replan 的「模型将继续」在真实停止后是错误状态（stop 事件可能丢失），
      // 必须换成停止提醒而不是保留。其余普通错误一律不碰循环提醒。
      if (e.details?.type === "session.error") {
        const sessionID = e.details.properties.sessionID
        // SDK 生成类型尚未收录 TextLoopStoppedError（错误定义在 message-v2.ts），先按 name 字符串判定。
        const errorName = (e.details.properties.error as { name?: string } | undefined)?.name
        if (!sessionID || errorName !== "TextLoopStoppedError") return
        const sessionKey = `${pathKey(e.name)}:${sessionID}`
        const previous = loopAlertedAtBySession.get(sessionKey)
        // "error" 是上一次由同一错误补出的停止提醒，同样不重复弹。
        const stoppedAlert = previous?.type === "ngram" || previous?.type === "stop" || previous?.type === "error"
        if (stoppedAlert && loopToastBySession.has(sessionKey)) return
        // 停止提醒已显示过但被用户/导航收起时，短时间内不重弹同一次停止。
        if (stoppedAlert && previous && Date.now() - previous.at < loopCooldownMs) return
        showLoopAlert(sessionKey, {
          directory: e.name,
          sessionID,
          title: language.t("notification.loopDetected.stopped.title"),
          description: language.t("notification.loopDetected.stopped.errorDescription", {
            sessionTitle: sessionLabel(e.name, sessionID),
            projectName: directoryLabel(e.name),
          }),
        })
        loopAlertedAtBySession.set(sessionKey, { at: Date.now(), type: "error" })
        return
      }

      // 260710 Red 文本重复检测 toast；261113 Red 来源一律取事件自带的目录与 sessionID
      //（不猜当前会话）——子代理跑飞时用户必须能看出是哪个会话、哪个项目。
      if (e.details?.type === "session.loop_detected") {
        const props = e.details.properties
        const sessionKey = `${pathKey(e.name)}:${props.sessionID}`
        const now = Date.now()
        const previous = loopAlertedAtBySession.get(sessionKey)
        if (previous?.type === props.type && now - previous.at < loopCooldownMs) return
        loopAlertedAtBySession.set(sessionKey, { at: now, type: props.type })

        // ngram 命中即断流、stop 是跨轮第 3 次终止，两者都已真停下；nudge/replan 只是
        // 给下一轮注入纠正提示、模型仍会继续——不能写成「已自动恢复」。
        const stopped = props.type === "ngram" || props.type === "stop"
        const typeLabel = props.type === "ngram" ? "N-gram" : props.type
        showLoopAlert(sessionKey, {
          directory: e.name,
          sessionID: props.sessionID,
          title: language.t(stopped ? "notification.loopDetected.stopped.title" : "notification.loopDetected.title"),
          description: language.t(
            stopped ? "notification.loopDetected.stopped.description" : "notification.loopDetected.description",
            {
              sessionTitle: sessionLabel(e.name, props.sessionID),
              projectName: directoryLabel(e.name),
              type: typeLabel,
            },
          ),
        })
        return
      }

      // 260823 Red 压缩完成 toast：compaction.ts 先回填 tokens_before/after 再发 Compacted
      // 事件（compaction.ts:716-728），消息流里最后一条 CompactionPart 一定带数字，
      // 所以能报「180k → 32k」而不是一句空话。拿不到数字（非标准压缩路径）就只报标题。
      if (e.details?.type === "session.compacted") {
        const props = e.details.properties as { sessionID: string }
        const [store] = globalSync.child(e.name, { bootstrap: false })
        const last = findLastCompaction(
          store.message[props.sessionID] ?? [],
          (messageID) => store.part[messageID] ?? [],
        )
        const fmt = (n: number) => n.toLocaleString(language.intl())
        showToast({
          icon: "collapse" as any,
          title: language.t("notification.compacted.title"),
          description:
            last && last.tokens_before !== undefined && last.tokens_after !== undefined
              ? language.t("notification.compacted.description", {
                  before: fmt(last.tokens_before),
                  after: fmt(last.tokens_after),
                })
              : undefined,
        })
        return
      }

      if (e.details?.type !== "permission.asked" && e.details?.type !== "question.asked") return
      const title =
        e.details.type === "permission.asked"
          ? language.t("notification.permission.title")
          : language.t("notification.question.title")
      const icon = e.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
      const directory = e.name
      const props = e.details.properties
      if (e.details.type === "permission.asked" && permission.autoResponds(e.details.properties, directory)) return

      const [store] = globalSync.child(directory, { bootstrap: false })
      const session = store.session.find((s: any) => s.id === props.sessionID)
      const sessionKey = `${pathKey(directory)}:${props.sessionID}`

      const sessionTitle = session?.title ?? language.t("command.session.new")
      const projectName = getFilename(directory)
      const description =
        e.details.type === "permission.asked"
          ? language.t("notification.permission.description", { sessionTitle, projectName })
          : language.t("notification.question.description", { sessionTitle, projectName })
      const href = `/${base64Encode(directory)}/session/${props.sessionID}`

      const now = Date.now()
      const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
      if (now - lastAlerted < cooldownMs) return
      alertedAtBySession.set(sessionKey, now)

      if (e.details.type === "permission.asked") {
        if (settings.sounds.permissionsEnabled()) {
          void playSoundById(settings.sounds.permissions())
        }
      }

      const notificationsEnabled =
        e.details.type === "permission.asked" ? settings.notifications.permissions() : settings.notifications.agent()
      if (notificationsEnabled) {
        const request = {}
        pendingBySession.set(sessionKey, request)
        let notified = false
        try {
          notified = (await platform.notify(title, description, href)) === true
        } catch {
          // 260930 Red 系统通知失败时回退应用内提示，避免 promise rejection 漏出。
        }
        if (pendingBySession.get(sessionKey) !== request) return
        pendingBySession.delete(sessionKey)
        if (notified) {
          dismissSessionAlert(sessionKey)
          return
        }
      }

      const currentSession = params.id
      if (pathKey(directory) === pathKey(currentDir()) && props.sessionID === currentSession) return
      if (pathKey(directory) === pathKey(currentDir()) && session?.parentID === currentSession) return

      dismissSessionAlert(sessionKey)

      const toastId = showToast({
        persistent: true,
        icon,
        title,
        description,
        actions: [
          {
            label: language.t("notification.action.goToSession"),
            onClick: () => navigate(href),
          },
          {
            label: language.t("common.dismiss"),
            onClick: "dismiss",
          },
        ],
      })
      toastBySession.set(sessionKey, toastId)
    })
    onCleanup(() => {
      unsub()
      pendingBySession.clear()
      loopAlertedAtBySession.clear()
      for (const toastId of toastBySession.values()) {
        toaster.dismiss(toastId)
      }
      toastBySession.clear()
      for (const toastId of loopToastBySession.values()) {
        toaster.dismiss(toastId)
      }
      loopToastBySession.clear()
    })

    createEffect(() => {
      const currentSession = params.id
      if (!currentDir() || !currentSession) return
      const directory = pathKey(currentDir())
      const sessionKey = `${directory}:${currentSession}`
      pendingBySession.delete(sessionKey)
      dismissSessionAlert(sessionKey)
      dismissLoopAlert(sessionKey)
      const [store] = globalSync.child(currentDir(), { bootstrap: false })
      const childSessions = store.session.filter((s: any) => s.parentID === currentSession)
      for (const child of childSessions) {
        const childKey = `${directory}:${child.id}`
        pendingBySession.delete(childKey)
        dismissSessionAlert(childKey)
        dismissLoopAlert(childKey)
      }
    })
  })
}
