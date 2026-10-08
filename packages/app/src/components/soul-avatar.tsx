import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Avatar, type AvatarProps } from "@redcode-ai/ui/avatar"
import { useSettings } from "@/context/settings"
import { resolveSoulAvatar, type AvatarSoul } from "@/utils/soul-avatar"

export function SoulAvatar(props: { id?: string; soul?: AvatarSoul; size?: AvatarProps["size"]; unbound?: boolean }) {
  const settings = useSettings()
  const identity = createMemo(() => {
    const id = props.id ?? props.soul?.id
    // 261008 Red 只有确实未绑定 Soul 的旧会话保留全局头像；缺失的已绑定 Soul 不借用它。
    if (!id && props.unbound) {
      return { name: settings.assistantProfile.displayName(), src: settings.assistantProfile.avatar() || undefined }
    }
    return resolveSoulAvatar(id, props.soul, settings.personalization.soulAvatar)
  })
  const [state, setState] = createStore({ failed: "" })
  const src = () => identity().src
  return (
    <div title={identity().name} aria-label={identity().name} data-soul-avatar={props.id ?? props.soul?.id ?? ""}>
      <Show
        when={src() && src() !== state.failed}
        fallback={
          <Avatar
            fallback={identity().name}
            size={props.size ?? "medium"}
            background="var(--syntax-keyword)"
            foreground="var(--text-on-accent)"
          />
        }
      >
        <div data-component="avatar" data-size={props.size ?? "medium"} data-has-image="">
          <img
            src={src()}
            alt={identity().name}
            draggable={false}
            data-slot="avatar-image"
            onError={() => setState("failed", src() ?? "")}
          />
        </div>
      </Show>
    </div>
  )
}
