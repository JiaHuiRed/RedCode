import * as Clipboard from "./clipboard"

type Toast = {
  show: (input: { message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (err: unknown) => void
}

type FocusableSelectionTarget = {
  hasSelection: () => boolean
  getClipboardText?: (text: string) => string
}

type SelectionSnapshot = {
  text: string
  anchor: { x: number; y: number }
  focus: { x: number; y: number }
  selectedRenderables: FocusableSelectionTarget[]
}

type Renderer = {
  getSelection: () =>
    | {
        getSelectedText: () => string
        selectedRenderables: FocusableSelectionTarget[]
        anchor: { x: number; y: number }
        focus: { x: number; y: number }
      }
    | null
  clearSelection: () => void
  currentFocusedRenderable?: FocusableSelectionTarget | null
}

type SelectionKeyEvent = {
  ctrl?: boolean
  name: string
  preventDefault: () => void
  stopPropagation: () => void
}

export function copy(renderer: Renderer, toast: Toast, writeClipboard = Clipboard.copy): boolean {
  const selection = renderer.getSelection()
  if (!selection) return false

  const text = selection.getSelectedText()
  if (!text) return false

  const focus = renderer.currentFocusedRenderable
  const clipboardText =
    focus?.getClipboardText && selection.selectedRenderables.includes(focus) ? focus.getClipboardText(text) : text

  void copyText(renderer, toast, clipboardText, writeClipboard)
  return true
}

export function copyText(renderer: Renderer, toast: Toast, text: string, writeClipboard = Clipboard.copy) {
  const selection = renderer.getSelection()
  const snapshot: SelectionSnapshot | undefined = selection
    ? {
        text: selection.getSelectedText(),
        anchor: { ...selection.anchor },
        focus: { ...selection.focus },
        selectedRenderables: [...selection.selectedRenderables],
      }
    : undefined

  return writeClipboard(text)
    .then(() => {
      const current = renderer.getSelection()
      const unchanged =
        snapshot &&
        current &&
        current.getSelectedText() === snapshot.text &&
        current.anchor.x === snapshot.anchor.x &&
        current.anchor.y === snapshot.anchor.y &&
        current.focus.x === snapshot.focus.x &&
        current.focus.y === snapshot.focus.y &&
        current.selectedRenderables.length === snapshot.selectedRenderables.length &&
        current.selectedRenderables.every((renderable, index) => renderable === snapshot.selectedRenderables[index])
      if (unchanged) renderer.clearSelection()
      toast.show({ message: "已复制到剪贴板", variant: "info" })
    })
    .catch(toast.error)
}

export function handleSelectionKey(renderer: Renderer, toast: Toast, event: SelectionKeyEvent) {
  const selection = renderer.getSelection()
  if (!selection) return

  if (event.ctrl && event.name === "c") {
    if (!copy(renderer, toast)) {
      renderer.clearSelection()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    return
  }

  if (event.name === "escape") {
    renderer.clearSelection()
    event.preventDefault()
    event.stopPropagation()
    return
  }

  const focus = renderer.currentFocusedRenderable
  if (focus?.hasSelection() && selection.selectedRenderables.includes(focus)) return

  renderer.clearSelection()
}

export * as Selection from "./selection"
