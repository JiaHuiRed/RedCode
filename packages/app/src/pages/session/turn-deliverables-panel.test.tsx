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

// 261121 Red 方案四：单文件走紧凑两行卡——无 header/数量/分页，主按钮与来源按钮同级，
// Tab 按视觉顺序；布局随 1→2 个文件自然切回网格。
test("a single deliverable renders the compact two-row card", () => {
  const [files, setFiles] = createSignal<TurnDeliverable[]>([output(1)])
  const opened: TurnDeliverable[] = []
  const sources: TurnDeliverable[] = []
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () => (
      <TurnDeliverables files={files()} onOpen={(file) => opened.push(file)} onSource={(file) => sources.push(file)} />
    ),
    container,
  )
  try {
    const section = () => container.querySelector<HTMLElement>('[data-component="turn-deliverables"]')!
    expect(section().dataset.single).toBe("")
    // 单文件卡不渲染 header/数量徽章/分页 footer
    expect(container.querySelector("h3")).toBeNull()
    expect(container.querySelector(".turn-deliverables-pagination")).toBeNull()
    // 主按钮整块可点，含图标+文件名+主动作；来源是同级独立按钮
    const open = container.querySelector<HTMLButtonElement>('[aria-label="Read document docs/brief-1.md"]')!
    open.focus()
    open.click()
    expect(opened).toEqual([files()[0]!])
    const source = container.querySelector<HTMLButtonElement>('[aria-label="View source step docs/brief-1.md"]')!
    // open 在前、source 在后（DOM 顺序即 Tab 视觉顺序）
    expect(open.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    source.click()
    expect(sources).toEqual([files()[0]!])
    // 2 个文件 → 自然切回网格布局
    setFiles([output(1), output(2)])
    expect(section().dataset.single).toBeUndefined()
    expect(container.querySelectorAll("article")).toHaveLength(2)
    expect(container.querySelector("h3")).not.toBeNull()
  } finally {
    dispose()
    container.remove()
  }
})
