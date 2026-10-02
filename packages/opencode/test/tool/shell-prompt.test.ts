import { describe, expect, test } from "bun:test"
import { ShellPrompt } from "../../src/tool/shell/prompt"
import { ToolJsonSchema } from "../../src/tool/json-schema"

// 261001 Red Check every shell sibling while changing only its model-facing contract.
describe("shell prompt contracts", () => {
  for (const name of ["bash", "pwsh", "powershell", "cmd"]) {
    test(`${name} keeps execution and safety details within the description budget`, () => {
      const rendered = ShellPrompt.render(
        name,
        "win32",
        { maxLines: 321, maxBytes: 12345 },
        "D:\\fixture\\.redcode\\temp",
      )
      expect(rendered.description).toContain("321")
      expect(rendered.description).toContain("12345")
      expect(rendered.description).toContain("120000")
      expect(rendered.description).toContain("600000")
      expect(rendered.description).toContain("workdir")
      expect(rendered.description).toContain("Only commit, amend, push")
      expect(rendered.description).toContain("stage only intended files")
      expect(rendered.description).toContain("do not amend the failed commit")
      expect(Buffer.byteLength(rendered.description)).toBeLessThanOrEqual(4096)
      expect(rendered.description).not.toContain("If the commands are independent and can run in parallel")
      const schema = ToolJsonSchema.fromSchema(rendered.parameters)
      for (const parameter of ["command", "timeout", "workdir", "description"])
        expect(schema.properties).toHaveProperty(parameter)
    })
  }

  test("PowerShell 5.1 keeps its unsupported-chain warning", () => {
    const value = ShellPrompt.render("powershell", "win32", { maxLines: 100, maxBytes: 10000 }, "D:\\temp")
    expect(value.description).toContain("cmd1; if ($?) { cmd2 }")
    expect(value.description).toContain("does not support")
  })

  test("PowerShell 7 and cmd keep their distinct quoting syntax", () => {
    const limits = { maxLines: 100, maxBytes: 10000 }
    expect(ShellPrompt.render("pwsh", "win32", limits, "D:\\temp").description).toContain('& "path/to/exe"')
    const cmd = ShellPrompt.render("cmd", "win32", limits, "D:\\temp").description
    expect(cmd).toContain("%VAR%")
    expect(cmd).toContain("call")
  })
})
