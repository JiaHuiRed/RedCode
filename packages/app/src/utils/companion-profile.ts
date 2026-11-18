const HEADER = "<!-- redspace:preferred-name -->"
const FOOTER = "<!-- /redspace:preferred-name -->"

/** Only our own leading field is separated; existing USER.md content is otherwise kept verbatim. */
export function splitCompanionUser(content: string) {
  const pattern =
    /^<!-- redspace:preferred-name -->\r?\nPreferred name: ([^\r\n]*)\r?\n<!-- \/redspace:preferred-name -->\r?\n(?:\r?\n)?/
  const match = content.match(pattern)
  return match ? { nickname: match[1], notes: content.slice(match[0].length) } : { nickname: "", notes: content }
}

export function composeCompanionUser(nickname: string, notes: string) {
  const name = nickname.replace(/[\r\n]/g, " ").trim()
  return name ? `${HEADER}\nPreferred name: ${name}\n${FOOTER}\n\n${notes}` : notes
}
