import { describe, expect, test } from "bun:test"
import { composeCompanionUser, splitCompanionUser } from "./companion-profile"

describe("companion personal profile", () => {
  test("adding a preferred name keeps all existing notes verbatim", () => {
    const notes = "# Existing profile\r\n\r\n我喜欢安静。\r\nDo not replace these notes.\r\n"
    const saved = composeCompanionUser("哥哥", notes)
    expect(saved.endsWith(notes)).toBe(true)
    expect(splitCompanionUser(saved)).toEqual({ nickname: "哥哥", notes })
  })
  test("unmarked personal files are never parsed as our own editable field", () => {
    const content = "Preferred name: Alice\n\n# Notes\nExisting content."
    expect(splitCompanionUser(content)).toEqual({ nickname: "", notes: content })
    expect(composeCompanionUser("", content)).toBe(content)
  })
  test("editing or clearing the managed name does not duplicate its section", () => {
    const first = splitCompanionUser(composeCompanionUser("First", "Notes\n"))
    const changed = composeCompanionUser("Second", first.notes)
    expect(changed.match(/<!-- redspace:preferred-name -->/g)?.length).toBe(1)
    expect(splitCompanionUser(changed).nickname).toBe("Second")
    expect(composeCompanionUser("", splitCompanionUser(changed).notes)).toBe("Notes\n")
  })
})
