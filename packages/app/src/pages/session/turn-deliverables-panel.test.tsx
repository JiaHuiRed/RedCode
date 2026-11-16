import { expect, mock, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import * as languageContext from "@/context/language"
import { dict } from "@/i18n/en"
import type { TurnDeliverable } from "./turn-deliverables"
import { TurnDeliverables } from "./turn-deliverables-panel"

mock.module("@/context/language", () => ({
  ...languageContext,
  useLanguage: () => ({
    t: (key: keyof typeof dict, args: Record<string, string | number> = {}) =>
      Object.entries(args).reduce((text, [name, value]) => text.replace(`{{${name}}}`, String(value)), dict[key]),
  }),
}))

const output = (index: number): TurnDeliverable => ({
  path: `docs/brief-${index}.md`,
  kind: "document",
  change: "created",
  messageID: `msg_${index}`,
  partID: `part_${index}`,
})

test("cards open the selected file and expose its own source, with progressive disclosure", () => {
  const files = Array.from({ length: 14 }, (_, index) => output(index))
  const opened: TurnDeliverable[] = []
  const sources: TurnDeliverable[] = []
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () => (
      <TurnDeliverables files={files} onOpen={(file) => opened.push(file)} onSource={(file) => sources.push(file)} />
    ),
    container,
  )
  const buttons = () => Array.from(container.querySelectorAll("button"))
  try {
    expect(container.querySelectorAll("article")).toHaveLength(4)
    const open = container.querySelector<HTMLButtonElement>('[aria-label="Read document docs/brief-0.md"]')!
    open.focus()
    expect(document.activeElement).toBe(open)
    open.click()
    container.querySelector<HTMLButtonElement>('[aria-label="View source step docs/brief-1.md"]')!.click()
    expect(opened).toEqual([files[0]!])
    expect(sources).toEqual([files[1]!])
    buttons()
      .find((button) => button.textContent?.includes("Show 8 more"))!
      .click()
    expect(container.querySelectorAll("article")).toHaveLength(12)
    buttons()
      .find((button) => button.textContent?.includes("Show 2 more"))!
      .click()
    expect(container.querySelectorAll("article")).toHaveLength(14)
    buttons()
      .find((button) => button.textContent?.includes("Show less"))!
      .click()
    expect(container.querySelectorAll("article")).toHaveLength(4)
    expect(container.textContent).toContain("Opens the current workspace version")
  } finally {
    dispose()
    container.remove()
  }
})

test("an empty turn has no empty panel; updates replace the source rather than leaving stale actions", () => {
  const [files, setFiles] = createSignal<TurnDeliverable[]>([])
  const sources: TurnDeliverable[] = []
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () => <TurnDeliverables files={files()} onOpen={() => {}} onSource={(file) => sources.push(file)} />,
    container,
  )
  try {
    expect(container.querySelector("section")).toBeNull()
    setFiles([output(1)])
    expect(container.querySelectorAll("article")).toHaveLength(1)
    const revised = { ...output(1), partID: "edited-again" }
    setFiles([revised])
    container.querySelector<HTMLButtonElement>('[aria-label="View source step docs/brief-1.md"]')!.click()
    expect(sources).toEqual([revised])
    setFiles([])
    expect(container.querySelector("section")).toBeNull()
  } finally {
    dispose()
    container.remove()
  }
})
