import type { Prompt } from "@/context/prompt"
import type { PromptHistoryStoredEntry } from "./history"
import { findHistorySuggestion } from "./suggestion"
import { getCaretState } from "./editor-dom"

export type GhostDeps = {
  editorRef: HTMLElement
  store: { mode: string; popover: string | null; historyIndex: number }
  prompt: {
    current: () => Prompt
    set: (parts: Prompt, cursor?: number) => void
  }
  composing: () => boolean
  history: { entries: PromptHistoryStoredEntry[] }
  mirror: { input: boolean }
  setEditorText: (text: string) => void
  setCursorPosition: (parent: HTMLElement, position: number) => void
  resetHistoryNavigation: () => void
}

export function createGhostSystem(deps: GhostDeps) {
  const {
    editorRef,
    store,
    prompt,
    composing,
    history,
    mirror,
    setEditorText,
    setCursorPosition,
    resetHistoryNavigation,
  } = deps

  const clearGhost = () => {
    editorRef?.querySelectorAll("[data-ghost]").forEach((el) => el.remove())
  }

  const ghostSuffix = () => editorRef?.querySelector("[data-ghost]")?.textContent ?? ""

  const applyGhost = (suffix: string) => {
    clearGhost()
    if (!suffix) return
    const span = document.createElement("span")
    span.dataset.ghost = "true"
    span.setAttribute("contenteditable", "false")
    span.className = "opacity-40 pointer-events-none select-none"
    span.textContent = suffix
    editorRef.appendChild(span)
  }

  const updateGhost = () => {
    clearGhost()
    if (store.mode !== "normal" || store.popover || store.historyIndex >= 0 || composing()) return
    const parts = prompt.current().filter((part) => part.type !== "image")
    if (parts.some((part) => part.type !== "text")) return
    const text = parts.map((part) => ("content" in part ? part.content : "")).join("")
    if (!text || text.includes("\n")) return
    const { collapsed, cursorPosition } = getCaretState(editorRef, prompt.current)
    if (!collapsed || cursorPosition !== text.length) return
    const suffix = findHistorySuggestion(history.entries, text)
    if (suffix) applyGhost(suffix)
  }

  const acceptGhost = () => {
    const suffix = ghostSuffix()
    if (!suffix) return false
    clearGhost()
    const text = prompt
      .current()
      .filter((part) => part.type !== "image")
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    const full = text + suffix
    mirror.input = true
    prompt.set([{ type: "text", content: full, start: 0, end: full.length }], full.length)
    setEditorText(full)
    setCursorPosition(editorRef, full.length)
    resetHistoryNavigation()
    return true
  }

  return { clearGhost, ghostSuffix, applyGhost, updateGhost, acceptGhost }
}
