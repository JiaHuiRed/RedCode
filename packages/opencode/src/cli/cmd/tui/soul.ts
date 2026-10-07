export type SoulChoice = {
  id: string
  deprecated: boolean
  selector: boolean
}

export function parseSoulChoice(input: string): SoulChoice | undefined {
  const match = input.trim().match(/^\/(soul|tui-persona|gui-persona)(?:\s+(.+))?$/)
  if (!match) return
  const deprecated = match[1] !== "soul"
  const id = match[2]?.trim() ?? ""
  return { id, deprecated, selector: id.length === 0 }
}

export function resolveNewSessionSoul(saved: string | undefined, clientDefault?: string) {
  return saved || clientDefault
}

export function unknownSoulMessage(id: string, available: string[]) {
  return `Unknown Soul: ${id}. Available: ${available.join(", ") || "(none)"}`
}
