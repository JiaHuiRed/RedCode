/** Chat-bound identities never become an implicit Code default. Empty registries use the server's built-in behavior. */
export function chooseCodeSoul(input: {
  saved?: string
  serverDefault?: string
  souls: ReadonlyArray<{ id: string }>
  companions: ReadonlyArray<{ soulID: string }>
}) {
  const bound = new Set(input.companions.map((profile) => profile.soulID))
  const eligible = input.souls.filter((soul) => !bound.has(soul.id))
  return (
    [input.saved, input.serverDefault].find((id) => id && eligible.some((soul) => soul.id === id)) ?? eligible[0]?.id
  )
}
