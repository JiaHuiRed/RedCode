// 260605 Red Extract keyboard handler from session.tsx

import { shouldFocusTerminalOnKeyDown, focusTerminalById } from "@/pages/session/helpers"

export type SessionKeyboardInput = {
  isDialogActive: () => boolean
  inputRef: HTMLDivElement | undefined
  getViewTerminalOpened: () => boolean
  terminal: { readonly active: () => string | undefined }
  composer: { readonly blocked: () => boolean }
  isChildSession: () => boolean
  onMarkScrollGesture: () => void
}

function isEditableTarget(target: EventTarget | null | undefined) {
  if (!(target instanceof HTMLElement)) return false
  return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
}

function deepActiveElement() {
  let current: Element | null = document.activeElement
  while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
    current = current.shadowRoot.activeElement
  }
  return current instanceof HTMLElement ? current : undefined
}

export function createSessionKeyboard(input: SessionKeyboardInput) {
  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (input.isDialogActive()) return

    if (activeElement === input.inputRef) {
      if (event.key === "Escape") input.inputRef?.blur()
      return
    }

    // Prefer the open terminal over the composer when it can take focus
    if (input.getViewTerminalOpened()) {
      const id = input.terminal.active()
      if (id && shouldFocusTerminalOnKeyDown(event) && focusTerminalById(id)) return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      input.onMarkScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (input.composer.blocked() || input.isChildSession()) return
      input.inputRef?.focus()
    }
  }

  return { handleKeyDown }
}
