export type SoulChoice = {
  id: string
  selector: boolean
}

// 261008 Red 旧 /tui-persona、/gui-persona 已下线（seed 与 home 的命令文件同撤），不再解析别名。
export function parseSoulChoice(input: string): SoulChoice | undefined {
  const match = input.trim().match(/^\/soul(?:\s+(.+))?$/)
  if (!match) return
  const id = match[1]?.trim() ?? ""
  return { id, selector: id.length === 0 }
}

export function resolveNewSessionSoul(saved: string | undefined, clientDefault?: string) {
  return saved || clientDefault
}

export function unknownSoulMessage(id: string, available: string[]) {
  return `Unknown Soul: ${id}. Available: ${available.join(", ") || "(none)"}`
}
