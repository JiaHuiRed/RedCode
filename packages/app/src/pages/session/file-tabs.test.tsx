import { expect, mock, test } from "bun:test"
import { createEffect, createSignal, lazy, onCleanup, Show, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { FileComponentProvider } from "@redcode-ai/ui/context/file"
import { MarkedProvider } from "@redcode-ai/ui/context/marked"
import { Tabs } from "@redcode-ai/ui/tabs"
import { createFileFind } from "@redcode-ai/ui/pierre/file-find"
import type { FileSearchControl } from "@redcode-ai/ui/file"
import * as fileContext from "@/context/file"
import * as commentsContext from "@/context/comments"
import * as languageContext from "@/context/language"
import * as promptContext from "@/context/prompt"
import * as platformContext from "@/context/platform"
import * as layoutContext from "@/context/session-layout"
import { FileTabContent } from "./file-tabs"

const [active, setActive] = createSignal("file://REVIEW.md")
mock.module("@/context/file", () => ({
  ...fileContext,
  useFile: () => ({
    pathFromTab: (tab: string) => tab.replace("file://", ""),
    tab: (tab: string) => tab,
    get: () => ({ loaded: true, content: { type: "text", content: "# Review\nneedle" } }),
    ready: () => true,
    selectedLines: () => null,
    setSelectedLines: () => {},
    searchFilesAndDirectories: async () => [],
  }),
}))
mock.module("@/context/comments", () => ({
  ...commentsContext,
  useComments: () => ({ list: () => [], focus: () => undefined }),
}))
mock.module("@/context/language", () => ({ ...languageContext, useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/prompt", () => ({ ...promptContext, usePrompt: () => ({ context: {} }) }))
mock.module("@/context/platform", () => ({ ...platformContext, usePlatform: () => ({ platform: "web" }) }))
mock.module("@/context/session-layout", () => ({
  ...layoutContext,
  useSessionLayout: () => ({
    sessionKey: () => "test",
    tabs: () => ({ active, all: () => ["file://REVIEW.md", "file://OTHER.md"] }),
    view: () => ({ scroll: () => undefined, setScroll: () => {}, fileReturn: { current: () => undefined } }),
  }),
}))

// Use the supported file renderer injection. Keep the real find controller and
// the same effect-time handle registration as TextViewer; skip syntax workers/layout.
function SearchableFile(props: { search: FileSearchControl }) {
  let wrapper: HTMLDivElement | undefined
  const find = createFileFind({ wrapper: () => wrapper, overlay: () => undefined, getRoot: () => undefined })
  createEffect(() => {
    props.search.register({ focus: find.focus })
    onCleanup(() => props.search.register(null))
  })
  return (
    <div ref={wrapper} data-testid="source">
      <Show when={find.open()}>
        <input ref={find.setInput} value={find.query()} onInput={(e) => find.setQuery(e.currentTarget.value)} />
      </Show>
    </div>
  )
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
function findKey() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }))
}

function mountFileTabs() {
  setActive("file://REVIEW.md")
  const container = document.createElement("div")
  document.body.append(container)
  let loaded!: (value: { default: typeof SearchableFile }) => void
  // app.tsx deliberately lazy-loads FileImpl inside a local Suspense boundary.
  const FileImpl = lazy(
    () =>
      new Promise<{ default: typeof SearchableFile }>((resolve) => {
        loaded = resolve
      }),
  )
  const LazyFile = (props: { search: FileSearchControl }) => (
    <Suspense>
      <FileImpl {...props} />
    </Suspense>
  )
  const dispose = render(
    () => (
      <MarkedProvider>
        <FileComponentProvider component={LazyFile}>
          <Tabs value={active()}>
            <FileTabContent tab="file://REVIEW.md" />
            <FileTabContent tab="file://OTHER.md" />
          </Tabs>
        </FileComponentProvider>
      </MarkedProvider>
    ),
    container,
  )
  return {
    container,
    loaded: () => loaded({ default: SearchableFile }),
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

test("first Ctrl+F from Markdown reading focuses the mounted search and repeated Ctrl+F retains query", async () => {
  const { container, loaded, dispose } = mountFileTabs()
  try {
    await frame()
    expect(container.querySelector('[data-testid="source"]')).toBeNull()
    findKey()
    loaded()
    await Promise.resolve()
    await frame()
    expect(container.querySelector('[data-testid="source"]')).not.toBeNull()
    const input = container.querySelector("input")!
    expect(input).not.toBeNull()
    expect(document.activeElement === input).toBe(true)
    input.value = "needle"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    findKey()
    await frame()
    expect(container.querySelector("input") === input).toBe(true)
    expect(input.value).toBe("needle")
    setActive("file://OTHER.md")
    findKey()
    await frame()
    expect(document.activeElement === container.querySelector("input")).toBe(true)
    const panel =
      container.querySelector('[role="tabpanel"][data-selected]') ??
      container.querySelector('[role="tabpanel"][data-state="active"]')!
    const reading = Array.from(panel.querySelectorAll("button")).find(
      (button) => button.textContent === "file.view.reading",
    )!
    reading.click()
    expect(container.querySelector("input") === null).toBe(true)
    findKey()
    await frame()
    expect(document.activeElement === container.querySelector("input")).toBe(true)
  } finally {
    dispose()
  }
})

test("pending search cannot steal focus after switching tabs and composition is left alone", async () => {
  const { container, loaded, dispose } = mountFileTabs()
  try {
    await frame()
    const composing = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, isComposing: true, cancelable: true })
    window.dispatchEvent(composing)
    expect(composing.defaultPrevented).toBe(false)
    expect(container.querySelector('[data-testid="source"]')).toBeNull()
    findKey()
    findKey()
    setActive("file://OTHER.md")
    loaded()
    await Promise.resolve()
    await frame()
    expect(container.querySelector("input") === null).toBe(true)
    setActive("file://REVIEW.md")
    await frame()
    expect(container.querySelector("input") === null).toBe(true)
    findKey()
    await frame()
    expect(document.activeElement === container.querySelector("input")).toBe(true)
  } finally {
    dispose()
  }
})
