import { onCleanup, onMount } from "solid-js"
import { showToast, toaster } from "@redcode-ai/ui/toast"
import { useLanguage } from "@/context/language"

export function UpdateAvailableToast(props: {
  version: string
  install: () => void
  language: ReturnType<typeof useLanguage>
}) {
  let toastId: number | undefined

  onMount(() => {
    toastId = showToast({
      persistent: true,
      icon: "download",
      title: props.language.t("toast.update.title"),
      description: props.language.t("toast.update.description", { version: props.version }),
      actions: [
        {
          label: props.language.t("toast.update.action.installRestart"),
          onClick: props.install,
        },
        {
          label: props.language.t("toast.update.action.notYet"),
          onClick: "dismiss",
        },
      ],
    })
  })

  onCleanup(() => {
    if (toastId === undefined) return
    toaster.dismiss(toastId)
  })

  return null
}
