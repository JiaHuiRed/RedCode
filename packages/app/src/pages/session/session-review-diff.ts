import type { SetStoreFunction } from "solid-js/store"

export type ReviewDiffHelpersInput = {
  checksum: (value: string) => string | undefined
  tree: { reviewScroll: HTMLDivElement | undefined; pendingDiff: string | undefined; activeDiff: string | undefined }
  setTree: SetStoreFunction<{
    reviewScroll: HTMLDivElement | undefined
    pendingDiff: string | undefined
    activeDiff: string | undefined
  }>
  view: () => {
    setScroll: (panel: string, scroll: { x: number; y: number }) => void
    review: { openPath: (path: string) => void }
  }
  openReviewPanel: () => void
}

export function createReviewDiffHelpers(input: ReviewDiffHelpersInput) {
  const reviewDiffId = (path: string) => {
    const sum = input.checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = input.tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = input.tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    input.view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    input.openReviewPanel()
    input.view().review.openPath(path)
    input.setTree({ activeDiff: path, pendingDiff: path })
  }

  return {
    reviewDiffId,
    reviewDiffTop,
    scrollToReviewDiff,
    focusReviewDiff,
  }
}
