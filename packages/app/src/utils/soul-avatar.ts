export type AvatarSoul = {
  id: string
  name: string
  displayName: string
  avatar?: string
}

// 261008 Red 只解析用户保存的本地资源 key；Soul 中的 URL/文件路径绝不直接交给 img。
export function resolveSoulAvatar(
  id: string | undefined,
  soul: AvatarSoul | undefined,
  avatar: (key: string) => string,
) {
  const bound = soul?.id === id ? soul : undefined
  const key = bound?.avatar
  const candidate = id ? avatar(id) || (key && /^[a-z0-9][a-z0-9_-]*$/.test(key) ? avatar(key) : "") : ""
  return {
    name: bound?.displayName || bound?.name || id || "AI",
    src:
      candidate.length <= 256 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(candidate)
        ? candidate
        : undefined,
  }
}
