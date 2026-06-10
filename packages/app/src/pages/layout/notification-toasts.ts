import { createEffect, onCleanup, onMount } from "solid-js"
import { showToast, toaster } from "@redcode-ai/ui/toast"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { getFilename } from "@redcode-ai/core/util/path"
import { pathKey } from "@/utils/path-key"
import { playSoundById } from "@/utils/sound"
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
    const cooldownMs = 5000

    const dismissSessionAlert = (sessionKey: string) => {
      const toastId = toastBySession.get(sessionKey)
      if (toastId === undefined) return
      toaster.dismiss(toastId)
      toastBySession.delete(sessionKey)
      alertedAtBySession.delete(sessionKey)
    }

    const unsub = globalSDK.event.listen((e) => {
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
        const sessionKey = `${e.name}:${props.sessionID}`
        dismissSessionAlert(sessionKey)
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
      const sessionKey = `${directory}:${props.sessionID}`

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
        if (settings.notifications.permissions()) {
          void platform.notify(title, description, href)
        }
      }

      if (e.details.type === "question.asked") {
        if (settings.notifications.agent()) {
          void platform.notify(title, description, href)
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
    onCleanup(unsub)

    createEffect(() => {
      const currentSession = params.id
      if (!currentDir() || !currentSession) return
      const sessionKey = `${currentDir()}:${currentSession}`
      dismissSessionAlert(sessionKey)
      const [store] = globalSync.child(currentDir(), { bootstrap: false })
      const childSessions = store.session.filter((s: any) => s.parentID === currentSession)
      for (const child of childSessions) {
        dismissSessionAlert(`${currentDir()}:${child.id}`)
      }
    })
  })
}
