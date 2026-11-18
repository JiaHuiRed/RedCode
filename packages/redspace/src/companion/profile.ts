type Field = "preferred-name" | "companion-name"

const patterns = {
  "preferred-name":
    /^<!-- redspace:preferred-name -->\r?\nPreferred name: ([^\r\n]*)\r?\n<!-- \/redspace:preferred-name -->\r?\n(?:\r?\n)?/,
  "companion-name":
    /^<!-- redspace:companion-name -->\r?\nConversation name: ([^\r\n]*)\r?\n<!-- \/redspace:companion-name -->\r?\n(?:\r?\n)?/,
} satisfies Record<Field, RegExp>

export function profileField(content: string, field: Field) {
  const match = content.match(patterns[field])
  return match ? { value: match[1], rest: content.slice(match[0].length) } : { value: "", rest: content }
}

/** Replace only our leading field; free-form notes and imported identity text remain verbatim. */
export function withProfileField(content: string, field: Field, value: string) {
  const { rest } = profileField(content, field)
  if (!value) return rest
  const label = field === "preferred-name" ? "Preferred name" : "Conversation name"
  return `<!-- redspace:${field} -->\n${label}: ${value}\n<!-- /redspace:${field} -->\n\n${rest}`
}
