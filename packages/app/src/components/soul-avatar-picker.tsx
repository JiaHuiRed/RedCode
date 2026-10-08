import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@redcode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { prepareSoulAvatar } from "@/utils/soul-avatar-image"
import type { AvatarSoul } from "@/utils/soul-avatar"

export function SoulAvatarPicker(props: { soul: AvatarSoul }) {
  const language = useLanguage()
  const settings = useSettings()
  const [state, setState] = createStore({ busy: false, message: "", error: "" })
  let input: HTMLInputElement | undefined

  const select = async (event: Event) => {
    const target = event.currentTarget as HTMLInputElement
    const file = target.files?.[0]
    target.value = ""
    if (!file) return
    // 261008 Red 上传途中切换详情也只写原 Soul，不能把异步结果挂到新选中的人格。
    const id = props.soul.id
    setState({ busy: true, message: "", error: "" })
    const saved = await prepareSoulAvatar(file)
      .then((value) => settings.personalization.setSoulAvatar(id, value))
      .then(() => true, () => false)
    setState({
      busy: false,
      message: saved ? language.t("settings.personalization.avatarSaved") : "",
      error: saved ? "" : language.t("settings.personalization.avatarFailed"),
    })
  }

  return (
    <section class="flex flex-col gap-2">
      <h4 class="text-14-medium text-text-strong">{language.t("settings.personalization.avatarTitle")}</h4>
      <p class="text-12-regular text-text-weak">{language.t("settings.personalization.avatarDescription")}</p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        class="hidden"
        aria-label={language.t("settings.personalization.chooseAvatar")}
        onChange={(event) => void select(event)}
      />
      <div class="flex flex-wrap gap-2">
        <Button size="small" variant="secondary" disabled={state.busy} onClick={() => input?.click()}>
          {language.t(state.busy ? "common.loading" : "settings.personalization.chooseAvatar")}
        </Button>
        <Show when={settings.personalization.soulAvatar(props.soul.id)}>
          <Button
            size="small"
            variant="ghost"
            disabled={state.busy}
            onClick={() => {
              settings.personalization.setSoulAvatar(props.soul.id, "")
              setState({ message: language.t("settings.personalization.avatarSaved"), error: "" })
            }}
          >
            {language.t("settings.personalization.removeAvatar")}
          </Button>
        </Show>
      </div>
      <p aria-live="polite" class="text-12-regular text-text-weak">{state.message}</p>
      <Show when={state.error}>
        <p role="alert" class="text-12-regular text-text-danger-base">{state.error}</p>
      </Show>
    </section>
  )
}
