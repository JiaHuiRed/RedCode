export type PromptSubmission<T> = Readonly<{
  payload: T
  revision: number
}>

export function createSubmissionController() {
  let submitting = false
  let revision = 0

  return {
    acquire() {
      if (submitting) return false
      submitting = true
      return true
    },
    changed() {
      revision += 1
    },
    snapshot<T>(payload: T): PromptSubmission<T> {
      return { payload, revision }
    },
    canConsume<T>(submission: PromptSubmission<T>) {
      return submission.revision === revision
    },
    release() {
      submitting = false
    },
  }
}
