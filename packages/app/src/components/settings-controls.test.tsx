import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Switch } from "@redcode-ai/ui/switch"
import { Select } from "@redcode-ai/ui/select"
import { TextField } from "@redcode-ai/ui/text-field"
import { SettingsList, SettingsRow } from "./settings-list"

function referencedText(element: Element, attribute: string) {
  return (element.getAttribute(attribute) ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
}

describe("settings control accessible names", () => {
  test("the real switch uses the visible row name, description and controlled state", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const [checked, setChecked] = createSignal(false)
    const dispose = render(
      () => (
        <SettingsList>
          <SettingsRow title="Enable memory" description="Remember my preferences.">
            <Switch checked={checked()} onChange={setChecked} />
          </SettingsRow>
        </SettingsList>
      ),
      host,
    )
    try {
      const input = host.querySelector<HTMLInputElement>('input[role="switch"]')!
      expect(input).toBeTruthy()
      expect(referencedText(input, "aria-labelledby")).toContain("Enable memory")
      expect(referencedText(input, "aria-describedby")).toContain("Remember my preferences.")
      input.click()
      expect(checked()).toBe(true)
      expect(input.checked).toBe(true)
    } finally {
      dispose()
      host.remove()
    }
  })

  test("Select and TextField receive row labels while explicit names take precedence", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => (
        <SettingsList>
          <SettingsRow title="Default model" description="Used for new conversations.">
            <Select options={["Alpha", "Beta"]} current="Alpha" />
          </SettingsRow>
          <SettingsRow title="Your nickname" description="Visible on this device.">
            <TextField value="Red" />
          </SettingsRow>
          <SettingsRow title="General description" description="Other help">
            <TextField value="Qiu" aria-label="Specific name" />
          </SettingsRow>
        </SettingsList>
      ),
      host,
    )
    try {
      const select = host.querySelector('[data-slot="select-select-trigger"]')!
      expect(referencedText(select, "aria-labelledby")).toContain("Default model")
      expect(referencedText(select, "aria-describedby")).toContain("Used for new conversations.")
      const inputs = host.querySelectorAll('[data-slot="input-input"]')
      expect(referencedText(inputs[0], "aria-labelledby")).toContain("Your nickname")
      expect(inputs[1].getAttribute("aria-label")).toBe("Specific name")
      expect(inputs[1].getAttribute("aria-labelledby")).toBeNull()
    } finally {
      dispose()
      host.remove()
    }
  })
})
