import { describe, expect, test } from "bun:test"
import {
  findGroupHost,
  findPartHost,
  openGroupTrigger,
  revealWithinHost,
  textMounted,
  toolBodyTrigger,
} from "./timeline-locate"

const toggle = (trigger: HTMLElement, onOpen: () => void) => {
  trigger.addEventListener("click", () => {
    trigger.setAttribute("aria-expanded", "true")
    onOpen()
  })
}

function buildHost(input: { bodyOpen: boolean; text: string }) {
  const host = document.createElement("div")
  host.setAttribute("data-timeline-part-id", "prt_1")

  const collapsible = document.createElement("div")
  collapsible.setAttribute("data-component", "collapsible")
  collapsible.className = "tool-collapsible"
  const body = document.createElement("button")
  body.setAttribute("data-slot", "collapsible-trigger")
  body.setAttribute("aria-expanded", input.bodyOpen ? "true" : "false")
  const content = document.createElement("div")
  content.setAttribute("data-slot", "collapsible-content")
  collapsible.append(body, content)
  host.append(collapsible)
  if (input.bodyOpen) content.textContent = input.text
  toggle(body, () => (content.textContent = input.text))
  return { host, body, content }
}

function addNestedAccordion(container: HTMLElement, text: string) {
  const trigger = document.createElement("button")
  trigger.setAttribute("data-slot", "accordion-trigger")
  trigger.setAttribute("aria-expanded", "false")
  const item = document.createElement("div")
  item.setAttribute("data-slot", "accordion-item")
  item.append(trigger)
  container.append(item)
  let clicks = 0
  trigger.addEventListener("click", () => {
    clicks += 1
    trigger.setAttribute("aria-expanded", "true")
    item.append(document.createTextNode(text))
  })
  return { trigger, clicks: () => clicks }
}

const frame = () => Promise.resolve()

describe("revealWithinHost", () => {
  test("expands the tool body when the group is already open but the item is collapsed", async () => {
    const { host } = buildHost({ bodyOpen: false, text: "needle in tool output" })
    let found = 0

    const located = await revealWithinHost({ host: () => host, query: "needle", frame, onFound: () => found++ })

    expect(located).toBe(true)
    expect(found).toBe(1)
    expect(host.textContent).toContain("needle in tool output")
    expect(textMounted(host, "needle")).toBe(true)
  })

  test("keeps opening inner collapsed items until the hit text is actually mounted", async () => {
    const { host, body } = buildHost({ bodyOpen: true, text: "outer body" })
    const nested = addNestedAccordion(host.querySelector('[data-slot="collapsible-content"]')!, "deep needle")

    const located = await revealWithinHost({ host: () => host, query: "deep needle", frame })

    expect(located).toBe(true)
    expect(nested.clicks()).toBe(1)
    expect(body.getAttribute("aria-expanded")).toBe("true")
    expect(host.textContent).toContain("deep needle")
  })

  test("return-to-tool path (no query) expands only the tool body and leaves inner items collapsed", async () => {
    const { host, content } = buildHost({ bodyOpen: false, text: "tool body" })
    const nested = addNestedAccordion(content, "inner details")

    const located = await revealWithinHost({ host: () => host, frame })

    expect(located).toBe(true)
    expect(content.textContent).toContain("tool body")
    expect(nested.clicks()).toBe(0)
    expect(nested.trigger.getAttribute("aria-expanded")).toBe("false")
  })

  test("reports failure when the hit text never mounts", async () => {
    const { host } = buildHost({ bodyOpen: false, text: "unrelated output" })

    const located = await revealWithinHost({ host: () => host, query: "missing needle", frame })

    expect(located).toBe(false)
    expect(textMounted(host, "missing needle")).toBe(false)
  })

  test("waits for asynchronously mounted tool output after opening its body", async () => {
    const { host, content } = buildHost({ bodyOpen: false, text: "" })
    let frames = 0
    const located = await revealWithinHost({
      host: () => host,
      query: "late output",
      frame: async () => {
        if (++frames === 3) content.textContent = "late output"
      },
    })
    expect(located).toBe(true)
    expect(frames).toBe(3)
  })
})

describe("timeline locate selectors", () => {
  test("finds the part and its tool group by id", () => {
    const root = document.createElement("div")
    root.innerHTML = `
      <div data-timeline-part-ids="a,b">
        <button data-component="context-tool-group-trigger"></button>
        <div data-timeline-part-id="b"></div>
      </div>`

    const group = findGroupHost(root, "b")
    expect(group).toBeDefined()
    openGroupTrigger(group!)
    expect(findPartHost(root, "b")?.dataset.timelinePartId).toBe("b")
    expect(findPartHost(root, "zzz")).toBeUndefined()
  })

  test("toolBodyTrigger skips non-tool collapsibles", () => {
    const host = document.createElement("div")
    host.innerHTML = `<div data-component="collapsible"><button data-slot="collapsible-trigger"></button></div>`
    expect(toolBodyTrigger(host)).toBeUndefined()
  })
})
